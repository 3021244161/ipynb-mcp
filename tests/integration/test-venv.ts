// Where the test virtualenv lives, for every suite that needs one.
//
// The v6 round moved this into the temp directory — but only in `analyze-op.test.ts`
// and only in prose: five INTEGRATION files still built an 18 MB venv inside the
// working tree at `tests/.venv-test`, `.gitignore` hid it from `git status`, and
// README/COMPATIBILITY/CHANGELOG all said it had been removed (review v7 V7-5).
//
// One module decides it now, so a suite cannot quietly disagree with the docs
// again. `IPYNB_TEST_VENV` overrides the location for anyone who wants to reuse an
// environment across runs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
 * The venv's interpreter when it exists and can import what the sidecar needs,
 * otherwise the base interpreter.
 *
 * Callers used to check `existsSync(TEST_VENV_PY)` on its own, which prefers a venv
 * that cannot run a kernel — how a leftover directory made CI pass one run and fail
 * the next on identical code.
 */
export function usableInterpreter(requiredModules: readonly string[]): string {
  if (existsSync(TEST_VENV_PY) && canImport(TEST_VENV_PY, requiredModules)) {
    return TEST_VENV_PY;
  }
  return BASE_PYTHON;
}

/** Whether `candidate` can import every named module. */
export function canImport(candidate: string, modules: readonly string[]): boolean {
  return modules.every(
    (module) => spawnSync(candidate, ['-c', `import ${module}`], { timeout: 10_000 }).status === 0,
  );
}
