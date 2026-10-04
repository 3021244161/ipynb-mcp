// Where the test virtualenv lives, and how it gets built.
//
// The v6 round moved this into the temp directory — but only in `analyze-op.test.ts`
// and only in prose: five INTEGRATION files still built an 18 MB venv inside the
// working tree at `tests/.venv-test`, `.gitignore` hid it from `git status`, and the
// docs all said it had been removed (review v7 V7-5).
//
// v7 then moved the CONSTANTS here while leaving five copies of the build/validate/
// fall back logic behind, and `usableInterpreter`/`canImport` had zero callers — so
// the header below described an arrangement that did not exist (review v8 V8-5).
// `prepareVenv` is that arrangement: one place builds, validates and falls back, and
// the suites call it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The venv directory every suite uses. Never inside the repository. */
export const TEST_VENV_DIR =
  process.env['IPYNB_TEST_VENV'] ?? path.join(tmpdir(), 'ipynb-mcp-test-venv');

/** Alias kept for the existing call sites (`VENV_DIR` / `VENV_PY`). */
export const VENV_DIR = TEST_VENV_DIR;

/** The interpreter inside that venv, per platform layout. */
export const TEST_VENV_PY = path.join(
  TEST_VENV_DIR,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);

/** Alias kept for the existing call sites. */
export const VENV_PY = TEST_VENV_PY;

/** The interpreter to use for the base environment (`python` / `python3`). */
export const BASE_PYTHON =
  process.env['IPYNB_TEST_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');

/**
 * Marks a venv this suite created, so cleanup can tell it from one the user pointed
 * `IPYNB_TEST_VENV` at. `rmSync(VENV_DIR, { recursive: true })` on a real environment
 * deleted the user's virtualenv (review v7 V8-14 territory; the marker is what makes
 * the ownership claim checkable).
 */
const VENV_MARKER = '.ipynb-mcp-test-venv';

/** Whether `candidate` can import every named module. */
export function canImport(candidate: string, modules: readonly string[]): boolean {
  return modules.every(
    (module) => spawnSync(candidate, ['-c', `import ${module}`], { timeout: 10_000 }).status === 0,
  );
}

/** Alias kept for the analyze-op call site's wording. */
export const canRunSidecar = canImport;

/**
 * The interpreter a test file is USING, once it has called {@link prepareVenv}.
 *
 * It exists so a capability question can be asked about the RIGHT interpreter. The
 * nbformat cases in `run.test.ts` asked about `VENV_PY` while the run under test used
 * whatever the resolve picked, which may be the base interpreter — so a venv that
 * lacked nbformat reported an ENVIRONMENT gap as a product failure (review v8 V8-11).
 * Defaults to the base interpreter, so a read before the resolve cannot silently
 * answer "the venv".
 */
let resolvedInterpreter: string = BASE_PYTHON;

export function resolvedTestInterpreter(): string {
  return resolvedInterpreter;
}

export interface PrepareVenvOptions {
  /** Modules the venv must be able to import. */
  readonly modules: readonly string[];
  /**
   * TST-1: when set, a fallback to the base interpreter is a FAILURE rather than a
   * quiet downgrade — CI sets it so "the venv was unusable" cannot masquerade as a
   * greener suite.
   */
  readonly requireVenv?: boolean;
}

/**
 * Build (if needed), validate, and choose the interpreter to use.
 *
 * Returns the path the caller should use: the venv when it exists AND can serve the
 * required modules, otherwise the base interpreter.
 *
 * The validation is the substance, not a nicety. A venv sits at a path that
 * `existsSync` alone would prefer, so a leftover venv that cannot import what the
 * sidecar needs made CI pass one run and fail the next on identical code. An
 * unusable venv is therefore REMOVED (when this suite created it) rather than left
 * for the next run to trip over.
 */
export function prepareVenv(options: PrepareVenvOptions): string {
  resolvedInterpreter = resolveVenv(options);
  return resolvedInterpreter;
}

function resolveVenv(options: PrepareVenvOptions): string {
  const { modules, requireVenv = process.env['IPYNB_TEST_REQUIRE_VENV'] === '1' } = options;

  if (existsSync(TEST_VENV_PY) && canImport(TEST_VENV_PY, modules)) {
    return TEST_VENV_PY;
  }

  // A directory at the venv path that this suite did not create is NOT OURS TO TOUCH — and
  // that has to mean "not written to" as well as "not deleted".
  //
  // The v10 comment said "leaving it alone" while the code below went on to build a venv INTO
  // that same directory and stamp its marker there; on the next run the marker made the
  // deletion branch legitimate, so the user's environment (and its contents) were removed
  // (review v11 V11-9). `IPYNB_TEST_VENV` is documented as a way to point the suite at an
  // environment you already have, which makes this reachable by following the README.
  //
  // The tradeoff is explicit: a caller who points `IPYNB_TEST_VENV` at an environment missing
  // a module gets the base interpreter instead of a repaired copy of their environment.
  // `IPYNB_TEST_REQUIRE_VENV=1` turns that into a loud failure rather than a silent fallback.
  if (existsSync(TEST_VENV_DIR) && !existsSync(path.join(TEST_VENV_DIR, VENV_MARKER))) {
    if (requireVenv) {
      throw new Error(
        `IPYNB_TEST_REQUIRE_VENV=1 but ${TEST_VENV_DIR} cannot import ${modules.join(', ')} and this ` +
          'suite did not create it; point IPYNB_TEST_VENV at a usable environment or remove it yourself',
      );
    }
    process.stderr.write(
      `[test-venv] ${TEST_VENV_DIR} cannot import ${modules.join(', ')} and was not ` +
        'created by this suite; leaving it untouched and using the base interpreter\n',
    );
    return BASE_PYTHON;
  }

  // From here the directory is either absent or ours, so the suite may rebuild it.
  if (existsSync(TEST_VENV_DIR)) {
    rmSync(TEST_VENV_DIR, { recursive: true, force: true });
  }

  // Only build one from an interpreter that can actually serve it.
  if (!canImport(BASE_PYTHON, modules)) {
    if (requireVenv) {
      throw new Error(
        `IPYNB_TEST_REQUIRE_VENV=1 but neither ${TEST_VENV_PY} nor ${BASE_PYTHON} can import ` +
          `${modules.join(', ')}; the environment is not usable and a fallback would hide it`,
      );
    }
    return BASE_PYTHON;
  }

  try {
    execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', TEST_VENV_DIR], {
      stdio: 'ignore',
      timeout: 120_000,
    });
    writeFileSync(path.join(TEST_VENV_DIR, VENV_MARKER), 'created by tests/integration/test-venv.ts\n');
  } catch {
    // A venv is an optimisation, not a requirement: the base interpreter already
    // passed the capability check above.
    return BASE_PYTHON;
  }

  if (canImport(TEST_VENV_PY, modules)) {
    return TEST_VENV_PY;
  }
  rmSync(TEST_VENV_DIR, { recursive: true, force: true });
  if (requireVenv) {
    throw new Error(
      `IPYNB_TEST_REQUIRE_VENV=1 but the venv built at ${TEST_VENV_DIR} cannot import ${modules.join(', ')}`,
    );
  }
  return BASE_PYTHON;
}
