import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  defaultArtifactDir,
  normalizeForCompare,
  parseConfig,
  USAGE,
  validateStartupFiles,
  type EnvLike,
  type StartupFsDeps,
} from '../../src/config.js';

const BASE_ENV: EnvLike = {
  LOCALAPPDATA: 'C:/Users/test/AppData/Local',
  HOME: '/home/test',
};

function makeFsDeps(overrides?: Partial<StartupFsDeps> & { existingPaths?: readonly string[] }): StartupFsDeps {
  const existing = new Set(overrides?.existingPaths ?? []);
  const dirs = new Set<string>(['/root', 'C:/work']);
  return {
    existsSync: (p) => existing.has(p) || dirs.has(p),
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p,
    mkdirSync: () => undefined,
    homedir: () => 'C:/Users/test',
    ...overrides,
  };
}

describe('[step1] parseConfig defaults', () => {
  // The artifact default is platform-specific (SPEC §5.9), so the expectation has
  // to be too. Asserting the Windows value on every host is exactly what made
  // `unit` fail on ubuntu/macos the first time CI ran (issue #1 problem 1a):
  // `path.resolve('C:/…')` on Linux prepends the cwd, so the test compared a
  // mangled path against a Windows literal. Both halves are fixed: the parser no
  // longer mangles an already-absolute value, and this table pins all three
  // platform defaults.
  const PLATFORM_CASES = [
    {
      platform: 'win32' as NodeJS.Platform,
      env: { LOCALAPPDATA: 'C:/Users/test/AppData/Local', HOME: 'C:/Users/test' },
      root: 'C:/work',
      artifactDir: 'C:/Users/test/AppData/Local/ipynb-mcp/artifacts',
    },
    {
      platform: 'darwin' as NodeJS.Platform,
      env: { HOME: '/Users/test' },
      root: '/Users/test/work',
      artifactDir: '/Users/test/Library/Caches/ipynb-mcp/artifacts',
    },
    {
      platform: 'linux' as NodeJS.Platform,
      env: { HOME: '/home/test', XDG_CACHE_HOME: '/home/test/.cache' },
      root: '/home/test/work',
      artifactDir: '/home/test/.cache/ipynb-mcp/artifacts',
    },
  ];

  for (const testCase of PLATFORM_CASES) {
    it(`applies the documented defaults on ${testCase.platform} (SPEC §5.1/§5.9)`, () => {
      const result = parseConfig([], testCase.env, {
        fallbackRoot: testCase.root,
        platform: testCase.platform,
      });
      expect(result.errors).toEqual([]);
      expect(result.config).toBeDefined();
      const c = result.config!;
      expect(c.root).toBe(testCase.root);
      expect(c.allowOutsideRoot).toBe(false);
      expect(c.readOnly).toBe(false);
      expect(c.images).toBe('auto');
      expect(c.python).toBeNull();
      expect(c.kernelIdleSeconds).toBe(3600);
      expect(c.execTimeoutSeconds).toBe(300);
      expect(c.backgroundThresholdSeconds).toBe(30);
      expect(c.backupKeep).toBe(10);
      // Absolute in, absolute out — never resolved against the host's cwd.
      expect(c.artifactDir).toBe(testCase.artifactDir);
      expect(c.inlineTextChars).toBe(20000);
      expect(c.previewLines).toBe(12);
      expect(c.maxImagesPerCall).toBe(20);
      expect(c.maxImageBytes).toBe(20971520);
      expect(c.logLevel).toBe('info');
    });
  }

  it('leaves an absolute --artifact-dir exactly as given on a foreign platform', () => {
    // The host decides nothing here: a Win32-style absolute path stays absolute
    // even when the parser is told the platform is linux (and vice versa). This
    // is the regression that CI caught, isolated to one assertion.
    const windowsValue = parseConfig(['--artifact-dir', 'D:/cache/artifacts'], {}, { platform: 'linux' });
    expect(windowsValue.errors).toEqual([]);
    expect(windowsValue.config!.artifactDir).toBe('D:/cache/artifacts');

    const posixValue = parseConfig(['--artifact-dir', '/var/cache/artifacts'], {}, { platform: 'win32' });
    expect(posixValue.errors).toEqual([]);
    expect(posixValue.config!.artifactDir).toBe('/var/cache/artifacts');

    // …while a genuinely relative value is still resolved against the cwd, which
    // is what SPEC §4.1.3 requires of the returned artifact_path.
    const relative = parseConfig(['--artifact-dir', 'artifacts'], {}, { platform: 'linux' });
    expect(relative.errors).toEqual([]);
    expect(path.isAbsolute(relative.config!.artifactDir)).toBe(true);
  });

  it('resolves the linux artifact dir from XDG_CACHE_HOME', () => {
    const env: EnvLike = { XDG_CACHE_HOME: '/home/test/.cache' };
    expect(defaultArtifactDir('linux', env)).toBe('/home/test/.cache/ipynb-mcp/artifacts');
    expect(defaultArtifactDir('linux', { HOME: '/home/test' })).toBe('/home/test/.cache/ipynb-mcp/artifacts');
    expect(defaultArtifactDir('darwin', { HOME: '/Users/test' })).toBe('/Users/test/Library/Caches/ipynb-mcp/artifacts');
    expect(defaultArtifactDir('linux', {})).toBeNull();
  });
});

describe('[step1] precedence: CLI > env > default', () => {
  it('CLI beats env and default', () => {
    const result = parseConfig(
      ['--exec-timeout-seconds', '42'],
      { ...BASE_ENV, IPYNB_EXEC_TIMEOUT_SECONDS: '99' },
      { fallbackRoot: 'C:/work' },
    );
    expect(result.config?.execTimeoutSeconds).toBe(42);
  });

  it('env beats default', () => {
    const result = parseConfig([], { ...BASE_ENV, IPYNB_READ_ONLY: '1' }, { fallbackRoot: 'C:/work' });
    expect(result.config?.readOnly).toBe(true);
  });

  it('parses env booleans in common formats and rejects garbage', () => {
    expect(parseConfig([], { ...BASE_ENV, IPYNB_ALLOW_OUTSIDE_ROOT: 'true' }, { fallbackRoot: 'C:/work' }).config?.allowOutsideRoot).toBe(true);
    expect(parseConfig([], { ...BASE_ENV, IPYNB_ALLOW_OUTSIDE_ROOT: '0' }, { fallbackRoot: 'C:/work' }).config?.allowOutsideRoot).toBe(false);
    const bad = parseConfig([], { ...BASE_ENV, IPYNB_ALLOW_OUTSIDE_ROOT: 'maybe' }, { fallbackRoot: 'C:/work' });
    expect(bad.config).toBeUndefined();
    expect(bad.errors).toEqual([expect.stringContaining('invalid boolean for IPYNB_ALLOW_OUTSIDE_ROOT')]);
  });
});

describe('[step1] CLI parsing', () => {
  it('accepts --key value, --key=value, --flag and --no-flag', () => {
    const result = parseConfig(
      ['--read-only', '--root=C:/data', '--images', 'never', '--no-read-only'],
      BASE_ENV,
    );
    // --no-read-only comes after --read-only: last write wins in the map.
    expect(result.config?.readOnly).toBe(false);
    expect(result.config?.root).toBe('C:/data');
    expect(result.config?.images).toBe('never');
  });

  it('rejects unknown options, missing values and values for booleans', () => {
    expect(parseConfig(['--bogus'], BASE_ENV, { fallbackRoot: 'C:/work' }).errors).toContain('unknown option: --bogus');
    expect(parseConfig(['--root'], BASE_ENV, { fallbackRoot: 'C:/work' }).errors[0]).toContain('requires a value');
    expect(parseConfig(['--read-only=yes'], BASE_ENV, { fallbackRoot: 'C:/work' }).errors[0]).toContain('does not take a value');
    expect(parseConfig(['positional'], BASE_ENV, { fallbackRoot: 'C:/work' }).errors[0]).toContain('unexpected argument');
  });

  it('flags --help without touching config validity', () => {
    const result = parseConfig(['--help'], BASE_ENV);
    expect(result.helpRequested).toBe(true);
  });

  it('usage text is pure ASCII English (R16)', () => {
    expect([...USAGE].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true);
  });
});

describe('[step1] numeric and enum validation (startup errors → exit 2)', () => {
  it('rejects non-integer and out-of-range numbers', () => {
    expect(parseConfig(['--exec-timeout-seconds', '0'], BASE_ENV).errors[0]).toContain('must be >= 1');
    expect(parseConfig(['--exec-timeout-seconds', '86401'], BASE_ENV).errors[0]).toContain('must be <= 86400');
    expect(parseConfig(['--exec-timeout-seconds', '3.5'], BASE_ENV).errors[0]).toContain('must be an integer');
    expect(parseConfig(['--preview-lines', '-1'], BASE_ENV).errors[0]).toContain('must be >= 1');
  });

  it('rejects invalid enums with the allowed values listed', () => {
    const result = parseConfig(['--images', 'sometimes'], BASE_ENV);
    expect(result.errors[0]).toContain('auto|never|always');
    expect(
      parseConfig([], { ...BASE_ENV, IPYNB_LOG_LEVEL: 'loud' }, { fallbackRoot: 'C:/work' }).errors,
    ).toEqual([expect.stringContaining('--log-level must be one of debug|info|warn|error')]);
  });

  it('accepts boundary values', () => {
    const result = parseConfig(
      ['--exec-timeout-seconds', '1', '--max-images-per-call', '0', '--backup-keep', '0'],
      BASE_ENV,
      { fallbackRoot: 'C:/work' },
    );
    expect(result.errors).toEqual([]);
    expect(result.config?.execTimeoutSeconds).toBe(1);
    expect(result.config?.maxImagesPerCall).toBe(0);
  });
});

describe('[step1] normalizeForCompare', () => {
  it('lowercases and unifies separators on win32/darwin, preserves case elsewhere', () => {
    expect(normalizeForCompare('C:\\Work\\NoteBooks\\', 'win32')).toBe('c:/work/notebooks');
    expect(normalizeForCompare('/Users/Test/', 'darwin')).toBe('/users/test');
    expect(normalizeForCompare('/Home/Test/', 'linux')).toBe('/Home/Test');
  });
});

describe('[step1] validateStartupFiles (startup failures → exit 2, SPEC §5.1)', () => {
  const win32 = 'win32' as const;

  it('rejects a root that does not exist or is not a directory', () => {
    const cfg = parseConfig(['--root', 'C:/missing'], BASE_ENV).config!;
    expect(validateStartupFiles(cfg, makeFsDeps({ existingPaths: [] }), win32)).toContain(
      '--root does not exist: C:/missing',
    );
    const cfg2 = parseConfig(['--root', 'C:/work'], BASE_ENV).config!;
    const deps = makeFsDeps();
    const notDir = { ...deps, statSync: () => ({ isDirectory: () => false }) };
    expect(validateStartupFiles(cfg2, notDir, win32)[0]).toContain('not a directory');
  });

  it('rejects root equal to the user home directory', () => {
    const cfg = parseConfig(['--root', 'C:/Users/test'], BASE_ENV).config!;
    const errors = validateStartupFiles(
      cfg,
      makeFsDeps({ existingPaths: ['C:/Users/test'] }),
      win32,
    );
    expect(errors.join('\n')).toContain('user home directory');
  });

  it('rejects a filesystem root (case-insensitively on win32)', () => {
    const cfg = parseConfig(['--root', 'e:/'], BASE_ENV).config!;
    const deps = makeFsDeps({ existingPaths: ['e:/'] });
    expect(validateStartupFiles(cfg, deps, win32).join('\n')).toContain('filesystem root');
  });

  it('reports artifact directory creation failures', () => {
    const cfg = parseConfig([], BASE_ENV, { fallbackRoot: 'C:/work' }).config!;
    const deps = makeFsDeps();
    const failingMkdir = { ...deps, mkdirSync: () => { throw new Error('EPERM'); } };
    const errors = validateStartupFiles(cfg, failingMkdir, win32);
    expect(errors.join('\n')).toContain('cannot create artifact directory');
  });

  it('accepts a normal workspace root', () => {
    const cfg = parseConfig([], BASE_ENV, { fallbackRoot: 'C:/work' }).config!;
    expect(validateStartupFiles(cfg, makeFsDeps(), win32)).toEqual([]);
  });
});

describe('[step1][A16] empty environment values mean "not set"', () => {
  it('IPYNB_PYTHON="" falls back to auto resolution, not an empty interpreter', () => {
    const result = parseConfig([], { ...BASE_ENV, IPYNB_PYTHON: '' }, { fallbackRoot: 'C:/work' });
    expect(result.config?.python).toBeNull();
  });

  it('IPYNB_EXEC_TIMEOUT_SECONDS="" keeps the default instead of becoming 0', () => {
    const result = parseConfig([], { ...BASE_ENV, IPYNB_EXEC_TIMEOUT_SECONDS: '' }, { fallbackRoot: 'C:/work' });
    expect(result.config?.execTimeoutSeconds).toBe(300);
  });

  it('IPYNB_KERNEL_IDLE_SECONDS="" keeps the default instead of becoming 0', () => {
    const result = parseConfig([], { ...BASE_ENV, IPYNB_KERNEL_IDLE_SECONDS: '' }, { fallbackRoot: 'C:/work' });
    expect(result.config?.kernelIdleSeconds).toBe(3600);
  });
});

describe('[step1][W6] empty CLI values mean "not set" too (A16 fixed only the env half)', () => {
  it('--exec-timeout-seconds= keeps the default instead of becoming 0', () => {
    const result = parseConfig(['--exec-timeout-seconds='], BASE_ENV, { fallbackRoot: 'C:/work' });
    expect(result.errors).toEqual([]);
    expect(result.config?.execTimeoutSeconds).toBe(300);
  });

  it('--kernel-idle-seconds= keeps the default instead of becoming 0', () => {
    const result = parseConfig(['--kernel-idle-seconds='], BASE_ENV, { fallbackRoot: 'C:/work' });
    expect(result.config?.kernelIdleSeconds).toBe(3600);
  });

  it('--python "" stays auto-resolution instead of an empty interpreter', () => {
    const result = parseConfig(['--python', ''], BASE_ENV, { fallbackRoot: 'C:/work' });
    expect(result.config?.python).toBeNull();
  });

  it('an empty CLI value does not shadow the environment variable', () => {
    const result = parseConfig(['--backup-keep='], { ...BASE_ENV, IPYNB_BACKUP_KEEP: '3' }, { fallbackRoot: 'C:/work' });
    expect(result.config?.backupKeep).toBe(3);
  });

  it('a whitespace-only value counts as empty as well', () => {
    const result = parseConfig(['--inline-text-chars', '   '], BASE_ENV, { fallbackRoot: 'C:/work' });
    expect(result.config?.inlineTextChars).toBe(20000);
  });
});

describe('[step1][A14] a relative --artifact-dir resolves to an absolute path', () => {
  it('returns an absolute artifactDir for a relative CLI value', () => {
    const result = parseConfig(['--artifact-dir', './artifacts'], BASE_ENV, { fallbackRoot: 'C:/work' });
    const artifactDir = result.config?.artifactDir ?? '';
    expect(artifactDir.startsWith('/') || /^[A-Za-z]:\//.test(artifactDir)).toBe(true);
    expect(artifactDir.endsWith('artifacts')).toBe(true);
  });
});

describe('[step1][C6a] -h is an accepted help alias', () => {
  it('parses -h the same as --help', () => {
    expect(parseConfig(['-h'], BASE_ENV).helpRequested).toBe(true);
    expect(parseConfig(['--help'], BASE_ENV).helpRequested).toBe(true);
  });
});

describe('[step1][C6b] POSIX filesystem roots are rejected at startup', () => {
  it('isFilesystemRoot accepts "/" on linux (rejected later by startup validation)', async () => {
    const { validateStartupFiles } = await import('../../src/config.js');
    const errors = validateStartupFiles(
      { ...parseConfig([], BASE_ENV, { fallbackRoot: '/' }).config!, artifactDir: '/tmp/artifacts' },
      {
        existsSync: (target: string) => target === '/',
        statSync: () => ({ isDirectory: () => true }),
        realpathSync: (target: string) => target,
        mkdirSync: () => undefined,
        homedir: () => '/home/tester',
      },
      'linux',
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('filesystem root');
  });
});
