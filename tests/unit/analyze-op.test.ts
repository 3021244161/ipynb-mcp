// Review D2: the symtable analyzer itself must be covered in the DEFAULT
// test loop — the U18/U19b integration cases exist but `pnpm test` never
// ran them, so swapping symtable back for naive AST walking (or regex)
// kept everything green. This suite talks to the REAL sidecar analyze op
// and skips (with a recorded reason) when no Python is available, keeping
// the "no Python required" guarantee for unit tests.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/log.js';
import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';
// The venv arrangement is shared, not copied. This file used to hold the SIXTH copy
// of it — build, validate, marker-file ownership, fallback to base, cleanup — while
// `tests/integration/test-venv.ts` had been written to be the only one (review v8 V8-5,
// still open in v9). Two consequences of the copy were real: the copies drifted, and
// the helper nobody called could not be trusted to be correct.
import { BASE_PYTHON, TEST_VENV_PY, canRunSidecar, prepareVenv, resolvedTestInterpreter } from '../integration/test-venv.js';

// Whether a unit-test file may touch Python at all. The suite must pass on a machine
// with no interpreter (AGENTS §9), so the decision is made once and every case is
// guarded by it rather than by whatever `prepareVenv` happened to do.
const PYTHON_AVAILABLE =
  existsSync(TEST_VENV_PY) || spawnSync(BASE_PYTHON, ['-c', ''], { timeout: 5000 }).status === 0;

/** The interpreter every case here uses — resolved in ONE place, by the shared helper. */
function interpreter(): string {
  return resolvedTestInterpreter();
}

/**
 * Every module the sidecar imports at startup, plus what the ANALYZER cases need.
 *
 * `nbformat` is in the list because this file's purpose is to check the analyzer
 * against real source; asking for it here means the resolve cannot hand back an
 * interpreter that would make the cases skip for an environment reason.
 */
const REQUIRED_MODULES = [...SIDECAR_REQUIRED_MODULES];

/**
 * Can this machine actually run a kernel?
 *
 * Three outcomes, deliberately distinguished (review v3 TST-5): the old
 * "any failure -> skip" turned a regression in `start_kernel` itself into a
 * silently skipping, fully green suite.
 *   - started:           proceed.
 *   - noInterpreter:     nothing to test here; skip with the reason.
 *   - ipykernelMissing:  interpreter present but no kernel support; skip.
 *   - broken:            anything else (spawn regression, sidecar crash on an
 *                        interpreter that claims ipykernel) -> the caller FAILS.
 */
type ProbeOutcome =
  | { status: 'started' }
  | { status: 'noInterpreter' | 'ipykernelMissing' | 'zmqBroken' | 'broken'; reason: string };

let kernelProbe: Promise<ProbeOutcome> | null = null;

function probeKernelStartup(): Promise<ProbeOutcome> {
  kernelProbe ??= (async () => {
    if (!PYTHON_AVAILABLE) {
      return { status: 'noInterpreter', reason: 'no Python interpreter on this machine' };
    }
    const missing = SIDECAR_REQUIRED_MODULES.filter((module) => !runs(interpreter(), `import ${module}`));
    if (missing.length > 0) {
      return {
        status: 'ipykernelMissing',
        reason: `${interpreter()} cannot import ${missing.join(', ')}`
      };
    }
    // Both modules the sidecar imports at startup. The candidate chain in
    // src/kernel/interpreter.ts probes exactly this set (SIDECAR_REQUIRED_MODULES,
    // D-038) and would refuse a candidate missing either one — one source of truth,
    // so the probe and production cannot disagree and turn a missing module into a
    // product-looking failure.
    if (!runs(interpreter(), 'import zmq; zmq.Context().socket(zmq.PAIR)')) {
      // The interpreter advertises ipykernel but its pyzmq cannot open a
      // socket at all (this machine's `.venv-test`: pyzmq 26.2.0 aborts with
      // STATUS_STACK_BUFFER_OVERRUN). That is an environment defect, and it is
      // NOT ipynb-mcp's business to fail on it — but it must not be reported as
      // "no interpreter" either, so it gets its own outcome.
      return { status: 'zmqBroken', reason: `${interpreter()} cannot use pyzmq sockets` };
    }
    const transport = new SidecarTransport({ interpreterPath: interpreter(), onLog: () => undefined });
    try {
      await transport.startKernel({
        kernelId: 'probe-kernel',
        interpreterPath: interpreter(),
        kernelSpecName: 'python3',
        language: 'python',
      });
      return { status: 'started' };
    } catch (cause) {
      return { status: 'broken', reason: String(cause) };
    } finally {
      await transport.shutdownAll().catch(() => undefined);
    }
  })();
  return kernelProbe;
}

/** Whether the chosen interpreter can run a snippet (probing capability). */
function runs(candidate: string, snippet: string): boolean {
  return spawnSync(candidate, ['-c', snippet], { timeout: 10_000 }).status === 0;
}

/**
 * The interpreter this suite used BEFORE `prepareVenv` ran, so the assertion in
 * `afterAll` can tell "we did not have one" from "we deleted it".
 *
 * The v9 version of this file captured `existsSync(TEST_VENV_PY)` and asserted the path
 * still existed — which fails for a legitimate reason too: when the shared venv was
 * present and unusable, `prepareVenv` DELETES it (that is the V8-12 ownership rule
 * working as designed) and rebuilds it; if the rebuild cannot run (`python -m venv`
 * unavailable, the classic Debian case) the path is legitimately gone, and the failure
 * message accused the suite of deleting an environment it had created (review v10 V10-9
 * item ②). What may not happen is the suite deleting a venv it did NOT create, so that is
 * what is asserted now.
 */
let preExistingVenvWasUsable = false;

beforeAll(() => {
  if (!PYTHON_AVAILABLE) {
    return;
  }
  preExistingVenvWasUsable = existsSync(TEST_VENV_PY) && canRunSidecar(TEST_VENV_PY, REQUIRED_MODULES);
  prepareVenv({ modules: REQUIRED_MODULES });
}, 180_000);

afterAll(() => {
  // V8-12's regression, pinned where it bit: this suite shares the venv at
  // `IPYNB_TEST_VENV` with the integration suite, and its cleanup used to delete that
  // venv at the end of a unit run — pulling the interpreter out from under a
  // concurrently running integration case. Resolving is not owning, so a venv that was
  // there AND USABLE before this file ran must still be there afterwards.
  //
  // What this can and cannot catch: it observes the end state of THIS run, so it sees
  // the old `afterAll(removeOwnedVenv)` (which deleted unconditionally) and any future
  // cleanup that treats "resolved" as "owned". The window where two separate PROCESSES
  // race on the same venv is not reproducible inside one process; `fileParallelism:
  // false` in vitest.config.ts closes the part of it this repository controls, and the
  // ownership rule in `tests/integration/test-venv.ts` — with its own cases in
  // `tests/unit/test-venv-ownership.test.ts` — closes the rest.
  if (PYTHON_AVAILABLE && preExistingVenvWasUsable) {
    expect(
      existsSync(TEST_VENV_PY),
      `the unit run removed the usable shared test venv at ${TEST_VENV_PY}; test files must not delete an environment they did not create`,
    ).toBe(true);
  }
});


describe('[U18][D2] the symtable analyzer maps real source to defs/uses', () => {
  it.skipIf(!PYTHON_AVAILABLE)('tuple unpacking lands in module-level defs (regex cannot)', async () => {
    const transport = new SidecarTransport({ interpreterPath: interpreter(), onLog: () => undefined });
    try {
      const analysis = await transport.analyze(['a, b = f()', 'print(a)']);
      expect(analysis.ok).toBe(true);
      expect(analysis.defs[0]).toEqual(expect.arrayContaining(['a', 'b']));
      expect(analysis.uses[1]).toEqual(expect.arrayContaining(['a']));
    } finally {
      await transport.shutdownAll();
    }
  }, 30_000);

  it.skipIf(!PYTHON_AVAILABLE)('function-local variables do NOT count as module uses (U19b)', async () => {
    const transport = new SidecarTransport({ interpreterPath: interpreter(), onLog: () => undefined });
    try {
      const analysis = await transport.analyze(['tmp = 99', 'def g():\n    tmp = 2\n    return tmp']);
      expect(analysis.ok).toBe(true);
      // Cell 1 defines g at module level; its LOCAL tmp is neither a def
      // nor a use of the module-level tmp.
      expect(analysis.defs[1]).toEqual(['g']);
      expect(analysis.uses[1]).toEqual([]);
    } finally {
      await transport.shutdownAll();
    }
  }, 30_000);

  it.skipIf(!PYTHON_AVAILABLE)('a syntax error degrades the whole analysis (ok:false, failed indexes)', async () => {
    const transport = new SidecarTransport({ interpreterPath: interpreter(), onLog: () => undefined });
    try {
      const analysis = await transport.analyze(['x = 1', 'print(y)', 'def broken(:\n    pass']);
      expect(analysis.ok).toBe(false);
      expect(analysis.failedCellIndexes).toEqual([2]);
      // Cells that parsed still carry their symbols.
      expect(analysis.defs[0]).toEqual(['x']);
      expect(analysis.uses[1]).toEqual(['print', 'y']);
    } finally {
      await transport.shutdownAll();
    }
  }, 30_000);
});

describe('[U20][D2] non-Python kernels report method skipped', () => {
  it('stale_analysis.method is "skipped" and stale_cells stays empty', async (context) => {
    // This case needs a kernel that actually BOOTS: it drives runNotebook end
    // to end. Probe that capability BEFORE creating anything — the old order
    // built a venv first, so on a machine without Python the suite went red
    // before any guard ran, contradicting AGENTS §9 (review v3 TST-5).
    const kernelReady = await probeKernelStartup();
    if (
      kernelReady.status === 'noInterpreter' ||
      kernelReady.status === 'ipykernelMissing' ||
      kernelReady.status === 'zmqBroken'
    ) {
      context.skip(`cannot run this case here: ${kernelReady.reason}`);
      return;
    }
    if (kernelReady.status === 'broken') {
      // An interpreter that CLAIMS ipykernel but whose kernel cannot start is a
      // sidecar/spawn defect, not an environment gap: fail loudly.
      throw new Error(`start_kernel is broken with a capable interpreter: ${kernelReady.reason}`);
    }

    // No venv is created here any more: the shared `prepareVenv` resolved (and
    // validated) the one this case will use, and built a venv only if the base
    // interpreter could serve it.
    const { KernelRegistry } = await import('../../src/kernel/registry.js');
    const { runNotebook } = await import('../../src/run.js');
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
    const { realpathSync } = await import('node:fs');
    const { hasher } = await import('../../src/hash.js');

    const workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-u20-'));
    // A synthetic kernelspec labelled language:'r' whose argv still points at
    // a working Python interpreter: the kernel boots, but the LANGUAGE LABEL
    // drives the stale-analysis branch (SPEC §5.6 — Python-only analysis).
    const kernelsRoot = path.join(workspace, 'share', 'jupyter');
    await mkdir(path.join(kernelsRoot, 'kernels', 'fake-r'), { recursive: true });
    await writeFile(
      path.join(kernelsRoot, 'kernels', 'fake-r', 'kernel.json'),
      JSON.stringify({ argv: [interpreter(), '-m', 'ipykernel', '-f', '{connection_file}'], display_name: 'Fake R', language: 'r' }),
    );
    process.env['JUPYTER_PATH'] = kernelsRoot;
    const nb = path.join(workspace, 'u20.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'fake-r', display_name: 'Python 3' }, language_info: { name: 'r' } },
      cells: [
        { cell_type: 'code', id: 'c0', metadata: {}, source: 'x <- 1', outputs: [], execution_count: null },
        { cell_type: 'code', id: 'c1', metadata: {}, source: 'y <- x', outputs: [{ output_type: 'stream', name: 'stdout', text: 'old\n' }], execution_count: 3 },
      ],
    }));
    const registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') });
    try {
      const outcome = await runNotebook(
        {
          path: nb, cellSelector: '0', mode: 'auto', timeoutSeconds: 60,
          writeOutputs: true, clearOutputsBefore: true, createBackup: true,
        },
        {
          registry,
          hasher,
          config: {
            root: workspace, allowOutsideRoot: false, readOnly: false, images: 'auto', python: null,
            kernelIdleSeconds: 3600, execTimeoutSeconds: 300, backgroundThresholdSeconds: 30,
            backupKeep: 10, artifactDir: path.join(workspace, 'artifacts'), inlineTextChars: 20000,
            previewLines: 12, maxImagesPerCall: 20, maxImageBytes: 20971520, maxResponseBytes: 8_388_608,
            logLevel: 'error',
          },
          imagesPolicy: 'auto',
          realpath: (target) => realpathSync(target),
        },
      );
      expect(outcome.kernel_language).toBe('r');
      expect(outcome.stale_analysis).toEqual({ approximate: true, analysis_version: 1, method: 'skipped' });
      expect(outcome.stale_cells).toEqual([]);
      expect(outcome.warnings.map((warning) => warning.code)).toContain('stale_analysis_skipped');
    } finally {
      delete process.env['JUPYTER_PATH'];
      await registry.shutdownAll();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
