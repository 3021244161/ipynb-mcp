// V8-12: resolving an interpreter is not owning it.
//
// The shared test venv lives at `IPYNB_TEST_VENV` (default: a temp directory) and is
// used by BOTH suites, because the unit suite really does start a sidecar
// (`analyze-op.test.ts`). A previous version deleted that directory from an `afterAll`
// in whichever file had resolved it, so finishing a unit run pulled the interpreter out
// from under a concurrently running integration case.
//
// The rule that replaces it is testable without any concurrency: `prepareVenv` may
// delete a venv only when it created it, and "it created it" is recorded in a marker
// file. These cases drive the REAL helper against isolated directories, so a future
// "clean up after ourselves" edit cannot quietly reintroduce the ownership bug.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestVenvModule {
  readonly TEST_VENV_DIR: string;
  readonly TEST_VENV_PY: string;
  readonly BASE_PYTHON: string;
  readonly prepareVenv: (options: { modules: readonly string[]; requireVenv?: boolean }) => string;
}

const MARKER = '.ipynb-mcp-test-venv';
const PYTHON_LAYOUT = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
/** A module name nothing can import, so the capability probe always fails. */
const IMPOSSIBLE = ['ipynb-mcp-module-that-does-not-exist'];

let sandbox: string;
let previousVenvEnv: string | undefined;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'ipynb-mcp-venv-ownership-'));
  previousVenvEnv = process.env['IPYNB_TEST_VENV'];
});

beforeEach(() => {
  // The helper reads `IPYNB_TEST_VENV` at module load, so every case needs a fresh
  // module instance — otherwise the first case's directory would be baked in for all
  // of them and the later cases would test the same path twice.
  vi.resetModules();
});

afterAll(() => {
  if (previousVenvEnv === undefined) {
    delete process.env['IPYNB_TEST_VENV'];
  } else {
    process.env['IPYNB_TEST_VENV'] = previousVenvEnv;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * A venv-shaped directory at `<sandbox>/<name>`, loaded as the helper's venv.
 *
 * Deliberately NOT a real virtualenv: every case here is about WHO OWNS the path, and
 * the capability probe fails on a stub file either way — which is the interesting
 * branch (a venv that cannot serve the sidecar).
 */
async function loadVenvDir(name: string, owned: boolean): Promise<TestVenvModule> {
  const dir = path.join(sandbox, name);
  mkdirSync(path.join(dir, ...PYTHON_LAYOUT.slice(0, -1)), { recursive: true });
  writeFileSync(path.join(dir, ...PYTHON_LAYOUT), 'not really an interpreter\n');
  if (owned) {
    writeFileSync(path.join(dir, MARKER), 'created by this test\n');
  }
  process.env['IPYNB_TEST_VENV'] = dir;
  const module = (await import('../integration/test-venv.js')) as TestVenvModule;
  expect(module.TEST_VENV_DIR).toBe(dir);
  return module;
}

describe('[V8-12] prepareVenv only deletes a venv it created', () => {
  it('leaves a foreign venv in place and falls back to the base interpreter', async () => {
    // No marker: this suite did not create it. Pointing IPYNB_TEST_VENV at a real
    // environment is a documented way to reuse one (V7-14), and pointing it at the venv
    // another suite is using is exactly what the integration suite does.
    const module = await loadVenvDir('foreign', false);
    const chosen = module.prepareVenv({ modules: IMPOSSIBLE });
    expect(existsSync(module.TEST_VENV_DIR)).toBe(true);
    expect(chosen).not.toBe(module.TEST_VENV_PY);
    expect(chosen).toBe(module.BASE_PYTHON);
  });

  it('removes its OWN venv when that venv cannot serve the sidecar', async () => {
    // The other half of the rule, and the reason it is a marker and not "delete
    // whatever is at the path": an unusable venv left behind makes the NEXT run fail
    // for an environment reason, which is how the same code passed one CI run and
    // failed the next (review v5 TST-5).
    const module = await loadVenvDir('own', true);
    module.prepareVenv({ modules: IMPOSSIBLE });
    expect(existsSync(module.TEST_VENV_DIR)).toBe(false);
  });

  it('does not delete anything when the environment requires a venv and none is usable', async () => {
    // `IPYNB_TEST_REQUIRE_VENV` turns the fallback into a failure. What must not change
    // is the ownership half: the failure may not be implemented by deleting whatever
    // sits at the path.
    const module = await loadVenvDir('required', false);
    expect(() => module.prepareVenv({ modules: IMPOSSIBLE, requireVenv: true })).toThrow(/IPYNB_TEST_REQUIRE_VENV/);
    expect(existsSync(module.TEST_VENV_DIR)).toBe(true);
  });
});
