// Interpreter resolution (SPEC §5.2, D23): candidate chain
//   1. explicit --python / IPYNB_PYTHON (failure is final)
//   2. notebook kernelspec argv[0]
//   3. notebook-dir .venv / venv
//   4. PATH python3 -> python
// Steps 2-4 degrade: a failed candidate is recorded and the chain continues;
// only when ALL fail do we raise. kernelspec_mismatch warnings per §5.2.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { normalizeForCompare } from '../config.js';

import { IpynbError, createWarning, type JsonValue, type Warning } from '../core/errors.js';

export interface InterpreterCandidate {
  readonly path: string;
  readonly reason: string;
}

export interface InterpreterResolution {
  readonly interpreterPath: string;
  readonly kernelSpecName: string;
  readonly language: string;
  readonly warnings: Warning[];
}

export interface InterpreterCache {
  get(candidatePath: string): boolean | undefined;
  set(candidatePath: string, ok: boolean): void;
}

/** Kernelspec name reported when the notebook declares none (D23 default). */
const DEFAULT_SPEC_NAME = 'python3';

/**
 * Modules the sidecar imports at startup, in the order it imports them.
 *
 * The probe below MUST test these and not a subset. The first version checked
 * `import ipykernel` alone (which is also all SPEC §5.2 asks for), so an
 * interpreter that provides ipykernel but not jupyter_client passed the probe and
 * then failed inside the sidecar with "jupyter_client is not importable" — an
 * internal error instead of the actionable "install this" message the candidate
 * chain exists to produce. CI hit it, and a real user hits it whenever a
 * kernelspec points at a trimmed or isolated environment (CI issue #1 problem 2,
 * D-038).
 *
 * `python/ipynb_sidecar.py` reads `from jupyter_client.manager import
 * KernelManager`; a test parses that import and fails if this list falls behind.
 */
export const SIDECAR_REQUIRED_MODULES = ['ipykernel', 'jupyter_client'] as const;

/**
 * Prints the first module the interpreter cannot import, then exits non-zero.
 * Importing beats `importlib.util.find_spec` here: it also catches a broken
 * install (a native extension that fails to load), which is exactly the pyzmq
 * class of failure this project has already been bitten by.
 */
function missingModuleScript(modules: readonly string[]): string {
  return [
    'import sys',
    `for name in ${JSON.stringify(modules)}:`,
    '    try:',
    '        __import__(name)',
    '    except Exception as exc:',
    '        sys.stdout.write(name)',
    '        sys.exit(3)',
    'sys.exit(0)',
  ].join('\n');
}

/** What a probe run concluded about one interpreter. */
export interface ProbeResult {
  readonly ok: boolean;
  /** The module that could not be imported, when the probe got that far. */
  readonly missingModule: string | null;
}

export interface InterpreterDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  existsSync(target: string): boolean;
  readFile(target: string): Promise<string>;
  /** Runs the command: 'ok' (exit 0), 'failed' (non-zero) or 'not-found' (ENOENT). */
  execFile(command: string, args: readonly string[], timeoutMs: number): Promise<'ok' | 'failed' | 'not-found'>;
  /**
   * Like `execFile` but returns stdout. Used by the capability probe so the
   * failure can name the missing module instead of only reporting a non-zero
   * exit (CI issue #1 problem 2).
   */
  runCapturing?(command: string, args: readonly string[], timeoutMs: number): Promise<{ status: 'ok' | 'failed' | 'not-found'; stdout: string }>;
  /** Absolute path of a PATH command (e.g. via `python -c "print(sys.executable)"`), null when absent. */
  resolveExecutable(command: string, timeoutMs: number): Promise<string | null>;
  homedir(): string;
}

export interface InterpreterInput {
  readonly explicitPython: string | null;
  readonly notebookPath: string;
  readonly kernelSpecName: string | null;
  readonly languageInfoName: string | null;
  readonly cache?: InterpreterCache;
}

interface KernelJsonInfo {
  readonly argv: readonly string[];
  readonly language: string | null;
  readonly dir: string;
}

export async function resolveInterpreter(
  input: InterpreterInput,
  deps: InterpreterDeps,
): Promise<InterpreterResolution> {
  const notebookDir = path.dirname(input.notebookPath);
  const failed: InterpreterCandidate[] = [];
  let installCommand: string | null = null;
  const warnings: Warning[] = [];

  const languageInfo = input.languageInfoName ?? null;
  const pythonRequested = (kernelLanguage: string | null): boolean =>
    kernelLanguage === 'python' || languageInfo === 'python';

  const venvPython = findVenvPython(notebookDir, deps);

  // ---- candidate 2 lookup (needed early for warnings + search paths) ------
  const specName = input.kernelSpecName;
  let kernelJson: KernelJsonInfo | null = null;
  if (specName === null || specName === '') {
    pushMismatch(warnings, 'notebook has no metadata.kernelspec.name; interpreter selection may not match the authoring environment');
  } else {
    kernelJson = await findKernelJson(specName, { explicitPython: input.explicitPython, venvPython }, deps);
    if (kernelJson === null) {
      pushMismatch(warnings, `kernelspec '${specName}' could not be resolved; falling back through the interpreter candidate chain`);
    }
  }

  // The probe answers two questions at once (usable? which module is missing?),
  // and the shared cache stores one boolean per candidate path, so the reason is
  // remembered alongside it. The key carries the required-module list, so an
  // entry from an older probe definition can never answer for this one.
  const probeKey = (candidate: string): string => `${candidate}\u0000${SIDECAR_REQUIRED_MODULES.join(',')}`;
  const probeReasons = new Map<string, string>();

  const probeInterpreter = async (candidate: string): Promise<ProbeResult> => {
    const cached = input.cache?.get(probeKey(candidate));
    if (cached !== undefined) {
      return cached ? { ok: true, missingModule: null } : { ok: false, missingModule: probeReasons.get(probeKey(candidate)) ?? null };
    }
    const script = missingModuleScript(SIDECAR_REQUIRED_MODULES);
    let result: ProbeResult;
    if (deps.runCapturing !== undefined) {
      const run = await deps.runCapturing(candidate, ['-c', script], 10_000);
      const reported = run.stdout.trim();
      result = run.status === 'ok' ? { ok: true, missingModule: null } : { ok: false, missingModule: reported === '' ? null : reported };
    } else {
      // No capturing runner injected: the exit status still refuses an
      // interpreter that cannot provide the modules, it just cannot say WHICH.
      const status = await deps.execFile(candidate, ['-c', script], 10_000);
      result = { ok: status === 'ok', missingModule: null };
    }
    input.cache?.set(probeKey(candidate), result.ok);
    if (result.missingModule !== null) {
      probeReasons.set(probeKey(candidate), result.missingModule);
    }
    return result;
  };

  // ---- candidate 1: explicit (failure is FINAL, never degrades) -----------
  if (input.explicitPython !== null) {
    const explicit = input.explicitPython;
    if (!deps.existsSync(explicit)) {
      throw new IpynbError('interpreter_not_found', `--python interpreter not found: ${explicit}`, {
        candidates: [{ path: explicit, reason: 'not found' }],
      });
    }
    const kernelLanguage = kernelJson?.language ?? languageInfo ?? 'python';
    if (pythonRequested(kernelLanguage)) {
      const probe = await probeInterpreter(explicit);
      if (!probe.ok) {
        throw new IpynbError('ipykernel_missing', missingModuleMessage('--python interpreter', explicit, probe), {
          path: explicit,
          install_command: installCommandFor(explicit, probe),
          ...(probe.missingModule === null ? {} : { missing_module: probe.missingModule }),
        });
      }
    }
    return {
      interpreterPath: explicit,
      kernelSpecName: specName ?? DEFAULT_SPEC_NAME,
      language: kernelLanguage,
      warnings,
    };
  }

  // ---- candidate 2: kernelspec argv[0] ------------------------------------
  if (kernelJson !== null) {
    const argv0 = kernelJson.argv[0] ?? '';
    const resolvedArgv0 = resolveArgv0(argv0, kernelJson.dir);
    if (argv0 !== '') {
      const language = kernelJson.language ?? languageInfo ?? 'python';
      if (!pythonRequested(language)) {
        // Non-Python kernel: the spec's executable is the interpreter (D23);
        // no ipykernel probing.
        maybeVenvMismatch(warnings, kernelJson, venvPython, deps);
        return {
          interpreterPath: resolvedArgv0,
          kernelSpecName: specName ?? '',
          language,
          warnings,
        };
      }
      if (deps.existsSync(resolvedArgv0)) {
        const probe = await probeInterpreter(resolvedArgv0);
        if (probe.ok) {
          maybeVenvMismatch(warnings, kernelJson, venvPython, deps);
          return {
            interpreterPath: resolvedArgv0,
            kernelSpecName: specName ?? '',
            language,
            warnings,
          };
        }
        failed.push({
          path: resolvedArgv0,
          reason: probe.missingModule === null ? 'ipykernel_missing' : `missing_module:${probe.missingModule}`,
        });
        installCommand = installCommandFor(resolvedArgv0, probe);
      } else {
        failed.push({ path: resolvedArgv0, reason: 'not found' });
      }
    }
  }

  // ---- candidate 3: notebook-dir .venv / venv -----------------------------
  if (venvPython !== null) {
    const probe = await probeInterpreter(venvPython);
    if (probe.ok) {
      // SPEC §5.2 trigger 3 is independent of whether the kernelspec
      // interpreter WORKED: a resolved kernelspec whose argv[0] differs from
      // the adjacent .venv must warn here too — this fallback path was the
      // only place it was missing (review D4 / I17).
      maybeVenvMismatch(warnings, kernelJson, venvPython, deps);
      return {
        interpreterPath: venvPython,
        kernelSpecName: specName ?? DEFAULT_SPEC_NAME,
        language: 'python',
        warnings,
      };
    }
    failed.push({
      path: venvPython,
      reason: probe.missingModule === null ? 'ipykernel_missing' : `missing_module:${probe.missingModule}`,
    });
    if (installCommand === null) {
      installCommand = installCommandFor(venvPython, probe);
    }
  }

  // ---- candidate 4: PATH python3 -> python --------------------------------
  const pathCandidates = deps.platform === 'win32' ? ['python'] : ['python3', 'python'];
  for (const candidate of pathCandidates) {
    const probe = await probeInterpreter(candidate);
    if (probe.ok) {
      return {
        interpreterPath: candidate,
        kernelSpecName: specName ?? DEFAULT_SPEC_NAME,
        language: 'python',
        warnings,
      };
    }
    failed.push({
      path: candidate,
      reason: probe.missingModule === null ? 'ipykernel_missing' : `missing_module:${probe.missingModule}`,
    });
    if (installCommand === null) {
      installCommand = installCommandFor(candidate, probe);
    }
  }

  const detail: JsonValue = {
    candidates: failed.map((entry) => ({ path: entry.path, reason: entry.reason })),
    ...(installCommand !== null ? { install_command: installCommand } : {}),
  };
  throw new IpynbError(
    'interpreter_not_found',
    'no usable Python interpreter found for this notebook (tried kernelspec, .venv/venv, PATH)',
    detail,
  );
}

// ---------------------------------------------------------------------------

/**
 * The user-facing sentence for a failed probe. It names the interpreter and, when
 * the probe got far enough to tell, the exact module that is missing. "cannot
 * import ipykernel" is a lie when ipykernel is present and jupyter_client is not,
 * and a lie sends the user to install something they already have
 * (CI issue #1 problem 2).
 */
function missingModuleMessage(context: string, interpreterPath: string, probe: ProbeResult): string {
  if (probe.missingModule === null) {
    return `${context} cannot provide the sidecar's Python modules (${SIDECAR_REQUIRED_MODULES.join(', ')}): ${interpreterPath}`;
  }
  return `${context} is missing the Python module '${probe.missingModule}': ${interpreterPath}`;
}

/** The command that actually fixes the reported problem. */
function installCommandFor(interpreterPath: string, probe: ProbeResult): string {
  const modules = probe.missingModule === null ? [...SIDECAR_REQUIRED_MODULES] : [probe.missingModule];
  return `"${interpreterPath}" -m pip install ${modules.join(' ')}`;
}

function pushMismatch(warnings: Warning[], message: string): void {
  if (!warnings.some((warning) => warning.code === 'kernelspec_mismatch')) {
    warnings.push(createWarning('kernelspec_mismatch', message));
  }
}

function maybeVenvMismatch(
  warnings: Warning[],
  kernelJson: KernelJsonInfo | null,
  venvPython: string | null,
  deps: InterpreterDeps,
): void {
  // Trigger 3 requires a RESOLVED kernelspec: when it did not resolve, the
  // missing-kernelspec trigger already covers the warning.
  if (venvPython === null || kernelJson === null) {
    return;
  }
  const argv0 = resolveArgv0(kernelJson.argv[0] ?? '', kernelJson.dir);
  // Case-fold ONLY on win32/darwin: a blanket toLowerCase() made two
  // genuinely different Linux paths compare equal (review C6d).
  const same =
    normalizeForCompare(path.resolve(argv0), deps.platform) ===
    normalizeForCompare(path.resolve(venvPython), deps.platform);
  if (!same) {
    pushMismatch(
      warnings,
      `notebook directory has a virtualenv whose interpreter differs from the kernelspec argv[0] (${argv0}); pass --python to override if this is wrong`,
    );
  }
}



/** Prefix of an interpreter: venvs put python in Scripts/ or bin/, conda
 *  environments put it directly in the environment root (SPEC §5.2). */
export function pythonPrefix(pythonPath: string): string {
  const parent = path.dirname(pythonPath);
  const parentBase = path.basename(parent).toLowerCase();
  if (parentBase === 'scripts' || parentBase === 'bin') {
    return path.dirname(parent);
  }
  return parent;
}

/** .venv/venv python next to the notebook, platform-shaped (SPEC §5.2 step 3). */
export function findVenvPython(notebookDir: string, deps: InterpreterDeps): string | null {
  const relative = deps.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const venvDir of ['.venv', 'venv']) {
    const candidate = path.join(notebookDir, venvDir, ...relative);
    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findKernelJson(
  specName: string,
  hints: { explicitPython: string | null; venvPython: string | null },
  deps: InterpreterDeps,
): Promise<KernelJsonInfo | null> {
  const searchDirs: string[] = [];
  // Kernelspecs also live under the prefix of any locatable Python
  // (SPEC §5.2 search path item 2: candidates 1/3/4, located not validated).
  const pathPythons: string[] = [];
  for (const command of deps.platform === 'win32' ? ['python'] : ['python3', 'python']) {
    const status = await deps.execFile(command, ['-c', ''], 5_000);
    if (status !== 'not-found') {
      pathPythons.push(command);
    }
  }
  const jupyterPath = deps.env['JUPYTER_PATH'];
  if (jupyterPath !== undefined && jupyterPath !== '') {
    const separator = deps.platform === 'win32' ? ';' : ':';
    for (const entry of jupyterPath.split(separator)) {
      if (entry !== '') {
        searchDirs.push(path.join(entry, 'kernels'));
      }
    }
  }
  for (const python of [hints.explicitPython, hints.venvPython, ...pathPythons]) {
    if (python === null) {
      continue;
    }
    let resolved: string | null = python;
    if (!path.isAbsolute(python) && !deps.existsSync(python)) {
      resolved = await deps.resolveExecutable(python, 5_000);
    }
    if (resolved !== null && deps.existsSync(resolved)) {
      const prefix = pythonPrefix(resolved);
      searchDirs.push(path.join(prefix, 'share', 'jupyter', 'kernels'));
    }
  }
  if (deps.platform === 'win32') {
    const appData = deps.env['APPDATA'];
    if (appData !== undefined) {
      searchDirs.push(path.join(appData, 'jupyter', 'kernels'));
    }
    const programData = deps.env['PROGRAMDATA'];
    if (programData !== undefined) {
      searchDirs.push(path.join(programData, 'jupyter', 'kernels'));
    }
  } else {
    const home = deps.homedir();
    searchDirs.push(path.join(home, '.local', 'share', 'jupyter', 'kernels'));
    searchDirs.push('/usr/local/share/jupyter/kernels');
    searchDirs.push('/usr/share/jupyter/kernels');
  }

  for (const dir of searchDirs) {
    const kernelJsonPath = path.join(dir, specName, 'kernel.json');
    if (!deps.existsSync(kernelJsonPath)) {
      continue;
    }
    try {
      const raw = await deps.readFile(kernelJsonPath);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      const argv = (parsed as Record<string, unknown>)['argv'];
      const language = (parsed as Record<string, unknown>)['language'];
      if (!Array.isArray(argv) || argv.length === 0) {
        continue;
      }
      return {
        argv: argv.filter((entry): entry is string => typeof entry === 'string'),
        language: typeof language === 'string' ? language : null,
        dir: path.dirname(kernelJsonPath),
      };
    } catch {
      // Unparseable kernel.json: keep searching other dirs.
      continue;
    }
  }
  return null;
}

/** kernel.json argv[0] -> absolute path ({resource_dir} + relative resolution). */
function resolveArgv0(argv0: string, kernelDir: string): string {
  if (argv0.includes('{resource_dir}')) {
    return argv0.replace('{resource_dir}', kernelDir);
  }
  if (path.isAbsolute(argv0)) {
    return argv0;
  }
  return path.resolve(kernelDir, argv0);
}

// ---------------------------------------------------------------------------
// Single entry point for callers (B1): the mcp tool layer and run
// orchestration must not assemble interpreter deps themselves.
// ---------------------------------------------------------------------------


/** Node adapter for InterpreterDeps (kept in the kernel layer, which owns process spawning). */
export function createNodeInterpreterDeps(platform: NodeJS.Platform): InterpreterDeps {
  return {
    platform,
    env: process.env,
    existsSync: (target) => existsSync(target),
    readFile: async (target) => readFile(target, 'utf8'),
    execFile: (command, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
          if (error === null) {
            resolve('ok');
          } else {
            resolve((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'failed');
          }
        });
      }),
    // The capability probe needs stdout as well as the status: the module that
    // could not be imported is what makes the error actionable, and it is printed
    // by the probe script rather than inferred from a non-zero exit.
    runCapturing: (command, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
          if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ status: 'not-found', stdout: '' });
            return;
          }
          resolve({ status: error === null ? 'ok' : 'failed', stdout: typeof stdout === 'string' ? stdout : '' });
        });
      }),
    resolveExecutable: (command, timeoutMs) =>
      new Promise((resolve) => {
        execFile(command, ['-c', 'import sys; print(sys.executable)'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const resolved = stdout.trim().split('\n')[0] ?? '';
          resolve(resolved === '' ? null : resolved);
        });
      }),
    homedir: () => homedir(),
  };
}

/**
 * Process-wide ipykernel probe cache shared by ALL entry points (B1).
 *
 * Entries EXPIRE (failures fast) because this cache feeds an error message that
 * tells the user to run `pip install ipykernel`: with a permanent cache,
 * following that advice still reported `ipykernel_missing` for the same
 * interpreter path until the MCP server was restarted (review v3 ARCH-2).
 */
const PROBE_TTL_OK_MS = 30_000;
const PROBE_TTL_FAILED_MS = 1_000;
const sharedProbeCache = new Map<string, { ok: boolean; at: number }>();

/** TTL-aware cache adapter; belongs to the kernel layer (it owns process probes). */
const probeCache: InterpreterCache = {
  get(candidatePath) {
    const entry = sharedProbeCache.get(candidatePath);
    if (entry === undefined) {
      return undefined;
    }
    const ttl = entry.ok ? PROBE_TTL_OK_MS : PROBE_TTL_FAILED_MS;
    if (Date.now() - entry.at > ttl) {
      sharedProbeCache.delete(candidatePath);
      return undefined;
    }
    return entry.ok;
  },
  set(candidatePath, ok) {
    sharedProbeCache.set(candidatePath, { ok, at: Date.now() });
  },
};

export interface ResolveForNotebookOptions {
  readonly notebookPath: string;
  readonly explicitPython: string | null;
  readonly platform?: NodeJS.Platform;
}

/**
 * Resolve the interpreter for a notebook from its metadata (SPEC §5.2/D23).
 * Both runNotebook and the notebook_kernel tool go through this single
 * entry — the .venv candidate needs the notebook's own directory, so the
 * path is required, not cosmetic.
 */
export async function resolveForNotebook(
  options: ResolveForNotebookOptions,
  resolveInput: {
    readonly kernelSpecName: string | null;
    readonly languageInfoName: string | null;
  },
): Promise<InterpreterResolution> {
  const platform = options.platform ?? process.platform;
  return resolveInterpreter(
    {
      explicitPython: options.explicitPython,
      notebookPath: options.notebookPath,
      kernelSpecName: resolveInput.kernelSpecName,
      languageInfoName: resolveInput.languageInfoName,
      cache: probeCache,
    },
    createNodeInterpreterDeps(platform),
  );
}
