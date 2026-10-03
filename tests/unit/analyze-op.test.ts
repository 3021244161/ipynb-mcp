// Review D2: the symtable analyzer itself must be covered in the DEFAULT
// test loop — the U18/U19b integration cases exist but `pnpm test` never
// ran them, so swapping symtable back for naive AST walking (or regex)
// kept everything green. This suite talks to the REAL sidecar analyze op
// and skips (with a recorded reason) when no Python is available, keeping
// the "no Python required" guarantee for unit tests.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/log.js';
import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';

// The venv used to live at `<repo>/tests/.venv-test`, i.e. inside the working
// tree: a test run created it there, left it behind, and any tool that globs the
// repository saw a virtualenv (review v5 TST-5). It lives in the temp directory
// now, so the repository is never a side effect of running the suite; override
// with IPYNB_TEST_VENV to reuse one across runs.
const VENV_DIR = process.env['IPYNB_TEST_VENV'] ?? path.join(tmpdir(), 'ipynb-mcp-test-venv');
const WINDOWS = process.platform === 'win32';
const VENV_PY = WINDOWS ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python');
const BASE_PYTHON = process.env['IPYNB_TEST_PYTHON'] ?? (WINDOWS ? 'python' : 'python3');

const PYTHON_AVAILABLE =
  existsSync(VENV_PY) ||
  spawnSync(WINDOWS ? 'python' : 'python3', ['-c', ''], { timeout: 5000 }).status === 0;

let chosenInterpreter: string | null = null;

/**
 * The interpreter every case in this file will use — and the one the capability
 * probe must judge. Resolving it once, in one place, is the fix for a CI failure
 * that had nothing to do with the product: the probe validated the BASE
 * interpreter (no venv existed yet) and the case then created a venv and ran with
 * THAT, so the first CI run passed and the second failed on the same code, purely
 * because the venv it left behind could not import jupyter_client.
 *
 * A venv is only preferred when it can actually run the sidecar; one that cannot
 * is removed so it cannot mislead a later run either. Override the location with
 * IPYNB_TEST_VENV.
 */
function interpreter(): string {
  if (chosenInterpreter !== null) {
    return chosenInterpreter;
  }
  if (existsSync(VENV_PY) && canRunSidecar(VENV_PY)) {
    chosenInterpreter = VENV_PY;
    return chosenInterpreter;
  }
  chosenInterpreter = BASE_PYTHON;
  return chosenInterpreter;
}

/** Every module the sidecar imports at startup (see SIDECAR_REQUIRED_MODULES). */
function canRunSidecar(candidate: string): boolean {
  return SIDECAR_REQUIRED_MODULES.every((module) => runs(candidate, `import ${module}`));
}

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
 * Decide the venv BEFORE anything reads `interpreter()`.
 *
 * A venv is created only when the base interpreter can serve it, and an existing
 * venv that cannot run the sidecar is removed rather than preferred. Both halves
 * matter: creating it lazily is what made CI pass once and fail once on the same
 * code (the first run probed the base interpreter and then ran in a venv it had
 * just created; the second run found that venv and probed IT), and leaving an
 * unusable one behind is what makes the failure survive into later runs.
 */
/**
 * Deletes the venv only when this test owns it.
 *
 * `VENV_DIR` comes from `IPYNB_TEST_VENV`, so pointing that at a real environment —
 * a plausible thing to do, since the variable exists precisely to reuse one — made
 * `rmSync(VENV_DIR, { recursive: true })` delete the user's virtualenv
 * (review v7 V7-14). Ownership is recorded in a marker file this test writes when
 * it creates the venv, and both delete sites go through here.
 */
const VENV_MARKER = '.ipynb-mcp-test-venv';

function removeOwnedVenv(): void {
  if (!existsSync(path.join(VENV_DIR, VENV_MARKER))) {
    // Not ours: leave it, and say so, because the caller is about to fall back to
    // the base interpreter and that decision should be explicable.
    process.stderr.write(
      `[analyze-op] ${VENV_DIR} exists but was not created by this test; leaving it alone\n`,
    );
    return;
  }
  rmSync(VENV_DIR, { recursive: true, force: true });
}

/**
 * Decide the venv BEFORE anything reads `interpreter()`.
 *
 * A venv is created only when the base interpreter can serve it, and an existing
 * venv that cannot run the sidecar is removed rather than preferred. Both halves
 * matter: creating it lazily is what made CI pass once and fail once on the same
 * code, and leaving an unusable one behind is what makes the failure survive into
 * later runs.
 */
function prepareTestVenv(): void {
  if (!PYTHON_AVAILABLE) {
    return;
  }
  if (existsSync(VENV_PY)) {
    if (!canRunSidecar(VENV_PY)) {
      removeOwnedVenv();
    }
    return;
  }
  // Only build one from an interpreter that can actually serve it.
  if (!canRunSidecar(BASE_PYTHON)) {
    return;
  }
  try {
    execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', VENV_DIR], {
      stdio: 'ignore',
      timeout: 120_000,
    });
    // Ownership marker, written first so a failed capability check can still clean
    // up what it just made.
    writeFileSync(path.join(VENV_DIR, VENV_MARKER), 'created by tests/unit/analyze-op.test.ts\n');
  } catch {
    // A venv is an optimisation here, not a requirement: the base interpreter
    // already passed the capability check, so fall back to it.
    return;
  }
  if (!canRunSidecar(VENV_PY)) {
    removeOwnedVenv();
  }
}

/**
 * The venv is removed at the END too, so a suite run does not leave it for the next
 * one — leaving it behind is how one CI run's leftover changed what the next run
 * measured. Only a venv this test created is touched.
 */
afterAll(() => {
  removeOwnedVenv();
});

beforeAll(() => {
  prepareTestVenv();
}, 180_000);

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

    // No venv is created here any more: `interpreter()` resolved (and validated)
    // the one this case will use, and created a venv only if the base interpreter
    // can serve it (see prepareTestVenv).
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
            previewLines: 12, maxImagesPerCall: 20, maxImageBytes: 20971520, logLevel: 'error',
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
