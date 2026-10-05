// Configuration parsing and startup validation (SPEC §5.1).
// Precedence: CLI args > environment variables > defaults.
// Startup-time failures exit with code 2 (never 1 or 0) — see bin.ts.

import path from 'node:path';

import type { LogLevel } from './log.js';

export type ImagesPolicy = 'auto' | 'never' | 'always';

export interface IpynbConfig {
  readonly root: string;
  readonly allowOutsideRoot: boolean;
  readonly readOnly: boolean;
  readonly images: ImagesPolicy;
  /** null = auto-resolve per candidate chain (SPEC §5.2). */
  readonly python: string | null;
  readonly kernelIdleSeconds: number;
  readonly execTimeoutSeconds: number;
  readonly backgroundThresholdSeconds: number;
  readonly backupKeep: number;
  readonly artifactDir: string;
  readonly inlineTextChars: number;
  readonly previewLines: number;
  readonly maxImagesPerCall: number;
  readonly maxImageBytes: number;
  /**
   * Budget for one tool response, in bytes.
   *
   * The SDK's stdio reader kills the connection on a frame over 10 MiB, and the client sees only
   * `-32000 Connection closed`, so this must stay below that with room for the JSON-RPC envelope. The
   * default is 8 MiB. See `src/core/response-budget.ts` and DEVIATIONS D-065.
   */
  readonly maxResponseBytes: number;
  readonly logLevel: LogLevel;
}

export interface EnvLike {
  readonly [key: string]: string | undefined;
}

export interface ParseConfigOptions {
  /** Used when neither CLI nor env provides --root. Default: process.cwd(). */
  readonly fallbackRoot?: string;
  /** Default: process.platform. */
  readonly platform?: NodeJS.Platform;
}

export interface ConfigParseResult {
  readonly config?: IpynbConfig;
  /** Startup errors (ASCII English); caller prints them to stderr and exits 2. */
  readonly errors: readonly string[];
  readonly helpRequested: boolean;
}

type OptionKind = 'string' | 'boolean' | 'enum' | 'number';

interface OptionSpec {
  readonly kind: OptionKind;
  readonly env?: string;
  readonly enumValues?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

const OPTION_SPECS: Readonly<Record<string, OptionSpec>> = {
  root: { kind: 'string', env: 'IPYNB_ROOT' },
  'allow-outside-root': { kind: 'boolean', env: 'IPYNB_ALLOW_OUTSIDE_ROOT' },
  'read-only': { kind: 'boolean', env: 'IPYNB_READ_ONLY' },
  images: { kind: 'enum', enumValues: ['auto', 'never', 'always'], env: 'IPYNB_IMAGES' },
  python: { kind: 'string', env: 'IPYNB_PYTHON' },
  'kernel-idle-seconds': { kind: 'number', env: 'IPYNB_KERNEL_IDLE_SECONDS', min: 1 },
  'exec-timeout-seconds': { kind: 'number', env: 'IPYNB_EXEC_TIMEOUT_SECONDS', min: 1, max: 86400 },
  'background-threshold-seconds': { kind: 'number', env: 'IPYNB_BACKGROUND_THRESHOLD_SECONDS', min: 1 },
  'backup-keep': { kind: 'number', env: 'IPYNB_BACKUP_KEEP', min: 0 },
  'artifact-dir': { kind: 'string', env: 'IPYNB_ARTIFACT_DIR' },
  'inline-text-chars': { kind: 'number', env: 'IPYNB_INLINE_TEXT_CHARS', min: 1 },
  'preview-lines': { kind: 'number', env: 'IPYNB_PREVIEW_LINES', min: 1 },
  'max-images-per-call': { kind: 'number', env: 'IPYNB_MAX_IMAGES_PER_CALL', min: 0 },
  'max-image-bytes': { kind: 'number', env: 'IPYNB_MAX_IMAGE_BYTES', min: 1 },
  'max-response-bytes': { kind: 'number', env: 'IPYNB_MAX_RESPONSE_BYTES', min: 65536 },
  'log-level': { kind: 'enum', enumValues: ['debug', 'info', 'warn', 'error'], env: 'IPYNB_LOG_LEVEL' },
};

const DEFAULTS: Readonly<Record<string, string>> = {
  images: 'auto',
  'kernel-idle-seconds': '3600',
  'exec-timeout-seconds': '300',
  'background-threshold-seconds': '30',
  'backup-keep': '10',
  'inline-text-chars': '20000',
  'preview-lines': '12',
  'max-images-per-call': '20',
  'max-image-bytes': '20971520',
  'max-response-bytes': '8388608',
  'log-level': 'info',
};

export const USAGE = `Usage: ipynb-mcp [options]

MCP server (stdio) for reading, editing and running local Jupyter notebooks.

Options:
  --root <dir>                        Root directory fence (default: cwd; IPYNB_ROOT)
  --allow-outside-root                Allow paths outside the root fence (IPYNB_ALLOW_OUTSIDE_ROOT)
  --read-only                         Only notebook_read and kernel status are allowed (IPYNB_READ_ONLY)
  --images <auto|never|always>        Image return policy (default: auto; IPYNB_IMAGES)
  --python <path>                     Explicit interpreter for kernels (IPYNB_PYTHON)
  --kernel-idle-seconds <n>           Idle kernel reclamation timeout (default: 3600)
  --exec-timeout-seconds <n>          Per-cell execution timeout (default: 300; range 1..86400)
  --background-threshold-seconds <n>  Runs longer than this go background (default: 30)
  --backup-keep <n>                   Rolling backup count per notebook (default: 10)
  --artifact-dir <dir>                Image artifact root (default: platform cache dir)
  --inline-text-chars <n>             Text truncation threshold (default: 20000)
  --preview-lines <n>                 Source preview line count (default: 12)
  --max-images-per-call <n>           Image blocks per tool call (default: 20)
  --max-image-bytes <n>               Max bytes per image (default: 20971520)
  --max-response-bytes <n>            Response budget in bytes (default: 8388608)
  --log-level <debug|info|warn|error> stderr log level (default: info)
  -h, --help                          Show this help and exit

Boolean flags accept a --no- prefix (e.g. --no-read-only). Every option has an
IPYNB_* environment variable equivalent; CLI values take precedence.`;

/** CLI tokens: `--key value`, `--key=value`, `--flag`, `--no-flag`. */
function parseCliArgs(argv: readonly string[]): { values: Map<string, string | boolean>; errors: string[] } {
  const values = new Map<string, string | boolean>();
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    // USAGE advertises "-h, --help": accept the short alias before the
    // "--"-only check rejects it (review C6a).
    if (arg === '-h') {
      values.set('help', true);
      continue;
    }
    if (!arg.startsWith('--')) {
      errors.push(`unexpected argument: ${arg}`);
      continue;
    }
    const body = arg.slice(2);
    if (body === '' || body === '-') {
      errors.push(`invalid argument: ${arg}`);
      continue;
    }
    if (body === 'help' || body === 'h') {
      values.set('help', true);
      continue;
    }
    const eq = body.indexOf('=');
    const hasEq = eq >= 0;
    let key = hasEq ? body.slice(0, eq) : body;
    let inlineValue = hasEq ? body.slice(eq + 1) : null;

    let negative = false;
    if (key.startsWith('no-')) {
      negative = true;
      key = key.slice(3);
    }
    const spec = OPTION_SPECS[key];
    if (spec === undefined) {
      errors.push(`unknown option: --${negative ? `no-${key}` : key}`);
      continue;
    }
    if (spec.kind === 'boolean') {
      if (inlineValue !== null) {
        errors.push(`option --${key} does not take a value`);
        continue;
      }
      if (negative) {
        values.set(key, false);
      } else {
        values.set(key, true);
      }
      continue;
    }
    if (negative) {
      errors.push(`option --${key} does not accept a --no- prefix`);
      continue;
    }
    if (inlineValue === null) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`option --${key} requires a value`);
        continue;
      }
      inlineValue = next;
      i += 1;
    }
    // `--opt=` and `--opt ""` mean "not set", exactly like an empty env value:
    // treating the empty string as a value made `--exec-timeout-seconds=` a
    // 0-second timeout and `--python ""` an explicit empty interpreter
    // (review A16 only fixed the env half; W6 covers the CLI half).
    if (inlineValue.trim() === '') {
      continue;
    }
    values.set(key, inlineValue);
  }
  return { values, errors };
}

function parseEnvBoolean(raw: string, envName: string, errors: string[]): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off' || value === '') {
    return false;
  }
  errors.push(`invalid boolean for ${envName}: ${raw}`);
  return undefined;
}

function parseNumber(raw: string, optionName: string, spec: OptionSpec, errors: string[]): number | undefined {
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    errors.push(`option --${optionName} must be an integer, got: ${raw}`);
    return undefined;
  }
  const value = Number(raw.trim());
  if (spec.min !== undefined && value < spec.min) {
    errors.push(`option --${optionName} must be >= ${spec.min}, got: ${value}`);
    return undefined;
  }
  if (spec.max !== undefined && value > spec.max) {
    errors.push(`option --${optionName} must be <= ${spec.max}, got: ${value}`);
    return undefined;
  }
  return value;
}

/** Platform-specific default artifact root (SPEC §5.9). Returns null when the needed env var is missing. */
export function defaultArtifactDir(platform: NodeJS.Platform, env: EnvLike): string | null {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    return local ? joinPath(local, 'ipynb-mcp', 'artifacts') : null;
  }
  if (platform === 'darwin') {
    const home = env['HOME'];
    return home ? joinPath(home, 'Library', 'Caches', 'ipynb-mcp', 'artifacts') : null;
  }
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg) {
    return joinPath(xdg, 'ipynb-mcp', 'artifacts');
  }
  const home = env['HOME'];
  return home ? joinPath(home, '.cache', 'ipynb-mcp', 'artifacts') : null;
}

function joinPath(...parts: readonly string[]): string {
  return parts.join('/').replace(/\\/g, '/');
}

function pathResolve(target: string): string {
  return path.resolve(target).replace(/\\/g, '/');
}

export function parseConfig(
  argv: readonly string[],
  env: EnvLike,
  options: ParseConfigOptions = {},
): ConfigParseResult {
  const fallbackRoot = options.fallbackRoot ?? process.cwd();
  const platform = options.platform ?? process.platform;

  const cli = parseCliArgs(argv);
  const errors: string[] = [...cli.errors];
  const helpRequested = cli.values.get('help') === true;

  const resolved: Record<string, string | boolean | number | null> = {};
  for (const [key, spec] of Object.entries(OPTION_SPECS)) {
    const cliValue = cli.values.get(key);
    const envRaw = spec.env !== undefined ? env[spec.env] : undefined;
    if (cliValue !== undefined) {
      if (spec.kind === 'boolean') {
        resolved[key] = cliValue === true;
      } else {
        resolved[key] = String(cliValue);
      }
      continue;
    }
    // An empty env value (VAR= in shell or .env) means "not set": treating it
    // as a value made IPYNB_PYTHON="" an explicit empty interpreter and turned
    // empty numbers into 0 (review A16).
    if (envRaw !== undefined && envRaw.trim() !== '') {
      if (spec.kind === 'boolean') {
        const parsed = parseEnvBoolean(envRaw, spec.env ?? '', errors);
        if (parsed !== undefined) {
          resolved[key] = parsed;
        }
        continue;
      }
      resolved[key] = envRaw;
      continue;
    }
    if (key === 'root') {
      resolved[key] = fallbackRoot;
      continue;
    }
    if (key === 'python') {
      resolved[key] = null;
      continue;
    }
    if (key === 'artifact-dir') {
      resolved[key] = defaultArtifactDir(platform, env);
      if (resolved[key] === null) {
        errors.push('cannot determine default artifact directory: set --artifact-dir or the required environment variable');
      }
      continue;
    }
    const fallback = DEFAULTS[key];
    if (fallback !== undefined) {
      resolved[key] = fallback;
    }
  }

  // Validate enum / number values in resolution order (CLI, env, default).
  for (const [key, spec] of Object.entries(OPTION_SPECS)) {
    const value = resolved[key];
    if (typeof value !== 'string' || value.trim() === '') {
      // Nothing empty can reach here any more (both the CLI and the env path
      // treat an empty value as "not set"), so this is purely a backstop: a
      // whitespace-only value must never fall through to Number('') === 0.
      continue;
    }
    if (spec.kind === 'enum') {
      const allowed = spec.enumValues ?? [];
      if (!allowed.includes(value)) {
        errors.push(`option --${key} must be one of ${allowed.join('|')}, got: ${value}`);
      }
      continue;
    }
    if (spec.kind === 'number') {
      const parsed = parseNumber(value, key, spec, errors);
      if (parsed !== undefined) {
        resolved[key] = parsed;
      }
    }
  }

  if (errors.length > 0) {
    return { errors, helpRequested };
  }

  const config: IpynbConfig = {
    root: String(resolved['root']),
    allowOutsideRoot: resolved['allow-outside-root'] === true,
    readOnly: resolved['read-only'] === true,
    images: resolved['images'] as ImagesPolicy,
    python: resolved['python'] === null ? null : String(resolved['python']),
    kernelIdleSeconds: Number(resolved['kernel-idle-seconds']),
    execTimeoutSeconds: Number(resolved['exec-timeout-seconds']),
    backgroundThresholdSeconds: Number(resolved['background-threshold-seconds']),
    backupKeep: Number(resolved['backup-keep']),
    // Explicit relative --artifact-dir values are resolved against the cwd:
    // artifact_path is a returned field and must be absolute (SPEC §4.1.3).
    // An absolute value is kept as given — including a Windows-style one on a
    // POSIX host, which `path.resolve` would have mangled (see absolutePath).
    artifactDir: absolutePath(String(resolved['artifact-dir'])),
    inlineTextChars: Number(resolved['inline-text-chars']),
    previewLines: Number(resolved['preview-lines']),
    maxImagesPerCall: Number(resolved['max-images-per-call']),
    maxImageBytes: Number(resolved['max-image-bytes']),
    maxResponseBytes: Number(resolved['max-response-bytes']),
    logLevel: resolved['log-level'] as LogLevel,
  };
  return { config, errors: [], helpRequested };
}

/**
 * Normalise a path for case-insensitive platforms (win32/darwin) — SPEC §5.3 reuse-key rule. */
export function normalizeForCompare(path: string, platform: NodeJS.Platform): string {
  let p = path.replace(/\\/g, '/');
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  if (platform === 'win32' || platform === 'darwin') {
    return p.toLowerCase();
  }
  return p;
}

/**
 * Make a configured path absolute, leaving an ALREADY-absolute one alone.
 *
 * `path.resolve` cannot be used blindly: it decides absoluteness with the
 * HOST's rules, so on Linux (CI!) `path.resolve('C:/x/y')` prepends the cwd and
 * produces `/home/runner/work/.../C:/x/y`. That is how the cross-platform
 * failures started — the configured value came out prefixed with the working
 * directory, and the test that expected the Windows default looked wrong
 * (review v6 / CI issue #1 problem 1a).
 *
 * The rule is deliberately HOST-INDEPENDENT: a value is left alone when it is
 * absolute for EITHER platform, and only a genuinely relative one is resolved
 * against the cwd. The previous version took a `platform` argument it never used
 * (`void platform;`) while its comment claimed the opposite behaviour, which is
 * how "absolute for the target platform" became "absolute for anyone" without
 * anything noticing (review v7 V7-9).
 *
 * The consequence is deliberate and worth stating: on Linux, `C:/x/y` is kept as
 * written and `mkdirSync('C:/x/y')` creates a directory literally named `C:` under
 * the cwd. That is the honest reading — the value cannot be interpreted on this
 * host at all, and inventing a POSIX meaning for a Windows path is exactly the
 * mangling this function exists to prevent.
 */
function absolutePath(target: string): string {
  const posixAbsolute = target.startsWith('/');
  // A drive-rooted or UNC spelling is absolute on Windows regardless of host.
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(target) || /^[\\/]{2}[^\\/]/.test(target);
  if (posixAbsolute || windowsAbsolute) {
    return target.replace(/\\/g, '/');
  }
  return pathResolve(target);
}

function isFilesystemRoot(normalizedPath: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return /^[a-z]:$/.test(normalizedPath);
  }
  // POSIX: '/' normalises to itself (not ''), so both spellings must count
  // (review C6b — `--root /` used to fence the whole filesystem).
  return normalizedPath === '' || normalizedPath === '/';
}

export interface StartupFsDeps {
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean };
  realpathSync(path: string): string;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
  homedir(): string;
}

/**
 * Filesystem-level startup checks (SPEC §5.1): root exists and is a directory,
 * is neither the user home directory nor a filesystem root, and the artifact
 * directory can be created. Any failure means exit code 2.
 */
export function validateStartupFiles(
  config: IpynbConfig,
  deps: StartupFsDeps,
  platform: NodeJS.Platform,
): readonly string[] {
  const errors: string[] = [];
  const root = config.root;

  if (!deps.existsSync(root)) {
    errors.push(`--root does not exist: ${root}`);
    return errors;
  }
  if (!deps.statSync(root).isDirectory()) {
    errors.push(`--root is not a directory: ${root}`);
    return errors;
  }

  let rootReal: string;
  try {
    rootReal = deps.realpathSync(root);
  } catch (cause) {
    errors.push(`--root cannot be resolved: ${root} (${String(cause)})`);
    return errors;
  }

  let homeReal = deps.homedir();
  try {
    homeReal = deps.realpathSync(homeReal);
  } catch {
    // homedir resolution failure is not fatal: fall back to the raw value.
  }
  if (normalizeForCompare(rootReal, platform) === normalizeForCompare(homeReal, platform)) {
    errors.push(`--root must not be the user home directory (${homeReal}); pass an explicit --root`);
  }
  if (isFilesystemRoot(normalizeForCompare(rootReal, platform), platform)) {
    errors.push(`--root must not be a filesystem root (${rootReal}); pass an explicit --root`);
  }

  try {
    deps.mkdirSync(config.artifactDir, { recursive: true });
  } catch (cause) {
    errors.push(`cannot create artifact directory: ${config.artifactDir} (${String(cause)})`);
  }

  return errors;
}
