// Interpreter resolution (SPEC §5.2 / D23) and the capability probe.
//
// The first CI run failed here in a way no local Windows run could show: the
// probe decided "this interpreter is capable" by importing `ipykernel`, while the
// sidecar needs `jupyter_client` too. An interpreter with one but not the other
// passed the probe and then died inside the sidecar with an internal error
// instead of the actionable "install this" message the candidate chain exists to
// produce (CI issue #1 problem 2 → D-038).
//
// What is pinned here:
//   1. the probe tests what the sidecar actually imports, and the failure names
//      the missing module and the exact install command;
//   2. a candidate that does not EXIST is not reported as missing modules, and no
//      install command is offered for it (SPEC §5.2, review v7 V7-6);
//   3. the probe's stdout can never become part of the install command, which is a
//      string this tool hands to a model to execute (review v7 V7-4);
//   4. the required-module list cannot drift away from the sidecar's imports —
//      the last case parses python/ipynb_sidecar.py and compares.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SIDECAR_REQUIRED_MODULES,
  createNodeInterpreterDeps,
  resolveInterpreter,
  type InterpreterDeps,
} from '../../src/kernel/interpreter.js';
import { IpynbError } from '../../src/core/errors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A fake machine: which interpreters exist and what each can import. */
interface FakeInterpreter {
  /** Modules importable in this interpreter. */
  readonly modules: readonly string[];
}

interface FakeWorld {
  readonly interpreters: Readonly<Record<string, FakeInterpreter>>;
  readonly pathCommands: Readonly<Record<string, string>>;
}

function fakeDeps(world: FakeWorld): InterpreterDeps & { readonly probed: string[] } {
  const probed: string[] = [];
  const deps: InterpreterDeps & { probed: string[] } = {
    probed,
    platform: 'linux',
    env: {},
    existsSync: (target) => world.interpreters[target] !== undefined,
    readFile: () => Promise.reject(new Error('no kernelspec in this fake world')),
    execFile: (command, args) => {
      // Only the probe uses -c here; report status without stdout.
      void args;
      probed.push(command);
      return Promise.resolve(world.interpreters[command] === undefined ? 'not-found' : 'ok');
    },
    runCapturing: (command, args) => {
      const interpreter = world.interpreters[command];
      if (interpreter === undefined) {
        return Promise.resolve({ status: 'not-found', stdout: '' });
      }
      probed.push(command);
      // Mimic the probe script: print the first module that fails to import.
      const missing = SIDECAR_REQUIRED_MODULES.find((name) => !interpreter.modules.includes(name));
      if (missing === undefined) {
        return Promise.resolve({ status: 'ok', stdout: '' });
      }
      void args;
      return Promise.resolve({ status: 'failed', stdout: missing });
    },
    resolveExecutable: (command) => Promise.resolve(world.pathCommands[command] ?? null),
    homedir: () => '/home/test',
  };
  return deps;
}

const NOTEBOOK = '/work/nb.ipynb';

/** Resolve and return the thrown error, so a passing case cannot be a missing throw. */
async function failureOf(
  deps: InterpreterDeps,
  input: { readonly explicitPython: string | null; readonly notebookPath: string },
): Promise<IpynbError> {
  const outcome = await resolveInterpreter(
    {
      ...input,
      kernelSpecName: null,
      languageInfoName: 'python',
      // A FRESH cache per call. The module-level probe cache is keyed by candidate
      // path, so without this a cached verdict from an earlier case in this file
      // answers for a case whose fake world is different — which is exactly how
      // these two cases failed while every individual behaviour they describe was
      // already correct (found by instrumenting the predicate: the function under
      // test was never reached, because a previous test's verdict was cached).
      cache: new Map(),
    },
    deps,
  ).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(outcome, 'resolution was expected to fail').toBeInstanceOf(IpynbError);
  return outcome as IpynbError;
}

describe('[CI-2][D-038] the capability probe matches what the sidecar needs', () => {
  it('accepts an interpreter that provides every sidecar module', async () => {
    const deps = fakeDeps({
      interpreters: { '/usr/bin/python3': { modules: [...SIDECAR_REQUIRED_MODULES] } },
      pathCommands: {},
    });
    const resolution = await resolveInterpreter(
      { explicitPython: '/usr/bin/python3', notebookPath: NOTEBOOK, kernelSpecName: null, languageInfoName: 'python' },
      deps,
    );
    expect(resolution.interpreterPath).toBe('/usr/bin/python3');
  });

  it('names the missing module and the command that fixes it', async () => {
    // The exact CI situation: ipykernel present, jupyter_client absent.
    const deps = fakeDeps({
      interpreters: { '/usr/bin/python3': { modules: ['ipykernel'] } },
      pathCommands: {},
    });
    const error = await failureOf(deps, { explicitPython: '/usr/bin/python3', notebookPath: NOTEBOOK });

    // `ipykernel_missing` is the §7 code for "this interpreter cannot host a
    // kernel"; the MESSAGE is where the precision goes.
    expect(error.code).toBe('ipykernel_missing');
    expect(error.message).toContain('jupyter_client');
    expect(error.message).not.toContain('ipykernel:');
    const detail = error.detail as Record<string, unknown>;
    expect(detail['missing_module']).toBe('jupyter_client');
    // Actionable: the command installs the module that is actually absent.
    expect(String(detail['install_command'])).toContain('pip install jupyter_client');
    expect(String(detail['install_command'])).not.toContain('pip install ipykernel');
  });

  it('refuses to fall back to an interpreter that only has ipykernel', async () => {
    // A candidate that cannot host a kernel must not be SELECTED, even when it is
    // the only candidate: the previous code returned it and let the sidecar fail
    // later, which is the "internal error instead of guidance" symptom.
    //
    // The notebook path matters: the `.venv` candidate is discovered next to the
    // notebook (through `deps.existsSync`), so a notebook elsewhere has no venv
    // candidate and this case would assert nothing about one. The path is built
    // with the HOST's `path.join`, which is what the source uses — a hard-coded
    // POSIX string silently matched nothing on Windows.
    const venvPython = path.join('/work', '.venv', 'bin', 'python');
    const deps = fakeDeps({
      interpreters: { [venvPython]: { modules: ['ipykernel'] } },
      pathCommands: {},
    });
    const error = await failureOf(deps, { explicitPython: null, notebookPath: '/work/nb.ipynb' });

    expect(error.code).toBe('interpreter_not_found');
    const candidates = (error.detail as Record<string, unknown>)['candidates'] as Array<Record<string, unknown>>;
    // The venv IS reported, and its reason names the missing module — not the
    // generic 'ipykernel_missing', which would send the user to install what the
    // interpreter already has.
    expect(candidates[0]).toEqual({
      path: venvPython,
      reason: 'missing_module:jupyter_client',
    });
  });

  it('the required-module list cannot drift from the sidecar imports', () => {
    // The probe is only as correct as this list, and the list lives in TypeScript
    // while the imports live in Python. Parsing the sidecar is the only way to
    // notice that one moved without the other.
    //
    // Only TOP-LEVEL third-party names count: `from jupyter_client.manager import
    // KernelManager` and `from jupyter_client.kernelspec import KernelSpec` are
    // one dependency, and `import symtable` is the standard library. `ipykernel`
    // is required even though it is imported only lazily, because it is what the
    // kernel process is launched as (`-m ipykernel`) and what the version probe
    // reads — an interpreter without it cannot host a kernel.
    const sidecar = readFileSync(path.join(REPO_ROOT, 'python', 'ipynb_sidecar.py'), 'utf8');
    const imported = new Set<string>();
    for (const match of sidecar.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
      const name = match[1]!;
      if (STDLIB.has(name) || name === '__future__') {
        continue;
      }
      imported.add(name);
    }
    const declared = new Set<string>(SIDECAR_REQUIRED_MODULES);
    // `ipykernel` is invoked rather than imported at module scope, so it is
    // declared without appearing as a top-level import.
    expect(imported.has('ipykernel')).toBe(false);
    expect(sidecar).toContain('-m", "ipykernel');
    for (const name of imported) {
      expect(declared.has(name), `the sidecar imports '${name}', which the probe does not require`).toBe(true);
    }
    for (const name of declared) {
      expect(
        imported.has(name) || name === 'ipykernel',
        `the probe requires '${name}', which the sidecar does not import`,
      ).toBe(true);
    }
  });

  it('the production deps can capture stdout (the probe depends on it)', () => {
    const deps = createNodeInterpreterDeps('linux');
    expect(typeof deps.runCapturing).toBe('function');
  });
});

describe('[V7-6] a candidate that does not exist is not reported as missing modules', () => {
  // SPEC §5.2: `install_command` names the first candidate that EXISTS but lacks
  // ipykernel. The PATH candidates set it unconditionally, so on a machine with no
  // python at all the model was handed `"python3" -m pip install …` — a command
  // that cannot run, presented as the way forward (review v7 V7-6).
  it('says "not found" and offers no install command when nothing exists', async () => {
    const deps = fakeDeps({ interpreters: {}, pathCommands: {} });
    const error = await failureOf(deps, { explicitPython: null, notebookPath: NOTEBOOK });

    const detail = error.detail as Record<string, unknown>;
    expect(detail['install_command']).toBeUndefined();
    const candidates = detail['candidates'] as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate['reason']).toBe('not found');
    }
  });

  it('still offers the command for an interpreter that exists and lacks a module', async () => {
    // The guard must not disable the guidance it protects: a PATH python that
    // exists without jupyter_client is exactly the case the command is for.
    const deps = fakeDeps({
      interpreters: { python3: { modules: ['ipykernel'] } },
      pathCommands: {},
    });
    const error = await failureOf(deps, { explicitPython: null, notebookPath: NOTEBOOK });

    const detail = error.detail as Record<string, unknown>;
    expect(String(detail['install_command'])).toContain('pip install jupyter_client');
    const candidates = detail['candidates'] as Array<Record<string, unknown>>;
    expect(candidates.find((entry) => entry['path'] === 'python3')?.['reason']).toBe('missing_module:jupyter_client');
  });
});

describe('[V7-4] the probe never lets a foreign process write the install command', () => {
  // The probe's stdout comes from a process we did not write, and
  // `install_command` is a command this tool HANDS TO A MODEL to run. A shim that
  // printed `jupyter_client && rm -rf ~/notebooks` used to be interpolated
  // verbatim (review v7 V7-4).
  it('ignores injected shell syntax', async () => {
    const deps = fakeDeps({ interpreters: { '/usr/bin/python3': { modules: [] } }, pathCommands: {} });
    deps.runCapturing = () => Promise.resolve({ status: 'failed', stdout: 'jupyter_client && rm -rf ~/notebooks' });

    const error = await failureOf(deps, { explicitPython: '/usr/bin/python3', notebookPath: NOTEBOOK });

    expect(error.code).toBe('ipykernel_missing');
    // Neither the message nor the detail may carry the injected text.
    expect(error.message).not.toContain('rm -rf');
    expect(JSON.stringify(error.detail)).not.toContain('rm -rf');
    // With nothing recognisable reported, the guidance degrades to the fixed list.
    const detail = error.detail as Record<string, unknown>;
    expect(detail['missing_module'], JSON.stringify(detail)).toBeUndefined();
    expect(String(detail['install_command'])).toContain('pip install ipykernel jupyter_client');
  });

  it('accepts only an exact module name from the whitelist', async () => {
    const deps = fakeDeps({ interpreters: { '/usr/bin/python3': { modules: [] } }, pathCommands: {} });
    deps.runCapturing = () => Promise.resolve({ status: 'failed', stdout: 'jupyter_client_evil' });

    const error = await failureOf(deps, { explicitPython: '/usr/bin/python3', notebookPath: NOTEBOOK });

    const detail = error.detail as Record<string, unknown>;
    expect(detail['missing_module']).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain('jupyter_client_evil');
  });

  it('does not carry an unbounded amount of foreign output into the detail', async () => {
    // A megabyte of stdout must not travel into an error a model has to read.
    const deps = fakeDeps({ interpreters: { '/usr/bin/python3': { modules: [] } }, pathCommands: {} });
    deps.runCapturing = () => Promise.resolve({ status: 'failed', stdout: 'x'.repeat(200_000) });

    const error = await failureOf(deps, { explicitPython: '/usr/bin/python3', notebookPath: NOTEBOOK });

    expect(JSON.stringify(error.detail).length).toBeLessThan(2000);
    expect(error.message.length).toBeLessThan(2000);
  });
});

/** Every standard-library module the sidecar imports (kept beside the check). */
const STDLIB = new Set([
  'json',
  'os',
  'sys',
  'tempfile',
  'threading',
  'time',
  'queue',
  'typing',
  'traceback',
  'signal',
  'ctypes',
  'platform',
  'importlib',
  // Used by the analyze op only, and the sidecar degrades to a regex pass when it
  // is unavailable (SPEC §5.6.1) — so it is deliberately NOT a hard requirement.
  'symtable',
]);
