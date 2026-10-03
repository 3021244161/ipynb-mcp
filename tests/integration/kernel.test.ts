// Integration tests (step 7a): real sidecar + real kernel.
// Requires an interpreter with ipykernel; provide it via IPYNB_TEST_PYTHON
// (defaults to the PATH python). A dedicated test venv is created from that
// base so the user's environment is never touched (AGENTS §3).

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/log.js';
import { SIDECAR_REQUIRED_MODULES } from '../../src/kernel/interpreter.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';
import { BASE_PYTHON, VENV_PY, prepareVenv } from './test-venv.js';

let workspace: string;
let notebookPath: string;
let registry: KernelRegistry;
/**
 * Interpreter this file actually drives. Resolving it is a CANDIDATE CHAIN, not
 * "the venv or bust": a test venv can be importable yet unusable (this
 * machine's `.venv-test` inherits pyzmq 26.2.0 from its conda base, which kills
 * the sidecar with 0xC0000409 the moment a kernel starts). Eight cases failing
 * for an environment reason hides real regressions. The base interpreter still
 * exercises exactly the same product code.
 */
let interpreter = VENV_PY;

async function canStartKernel(candidate: string): Promise<boolean> {
  if (!existsSync(candidate)) {
    return false;
  }
  const probe = new SidecarTransport({ interpreterPath: candidate, onLog: () => undefined });
  try {
    await probe.startKernel({
      kernelId: 'probe-kernel',
      interpreterPath: candidate,
      kernelSpecName: 'python3',
      language: 'python',
    });
    return true;
  } catch {
    return false;
  } finally {
    await probe.shutdownAll().catch(() => undefined);
  }
}

beforeAll(async () => {
    // ONE place builds, validates and falls back (review v8 V8-5: the constants had
  // been centralised while five copies of this logic remained, and the helper that
  // was supposed to replace them had no callers).
  prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
  // Prefer the dedicated venv; fall back to the base interpreter when it cannot
  // actually host a kernel, and say which one is in use.
  if (!(await canStartKernel(VENV_PY)) && (await canStartKernel(BASE_PYTHON))) {
    // TST-1: a fallback means the test environment — or our own interpreter
    // handling — is broken. In CI the venv is built from setup-python plus
    // `pip install ipykernel` and must work, so refuse to mask it there.
    if (process.env['CI'] === 'true' || process.env['IPYNB_TEST_REQUIRE_VENV'] === '1') {
      throw new Error(
        `test interpreter fallback: ${VENV_PY} cannot start a kernel and the run fell back to ${BASE_PYTHON}; refusing to mask an environment or spawn regression`,
      );
    }
    interpreter = BASE_PYTHON;
    process.stderr.write(
      `[kernel.test] ${VENV_PY} cannot start a kernel here; falling back to ${BASE_PYTHON}\n`,
    );
  }
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-kernel-'));
  notebookPath = path.join(workspace, 'nb.ipynb');
  await writeFile(notebookPath, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    cells: [],
  }));
  registry = new KernelRegistry({
    idleSeconds: 3600,
    logger: createLogger('debug'),
    transportFactory: (options) => new SidecarTransport(options),
  });
  registry.start();
}, 180_000);

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

function processExists(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('[I-smoke] sidecar transport with a real kernel', () => {
  it('pings and reports versions', async () => {
    const transport = new SidecarTransport({ interpreterPath: interpreter, onLog: () => undefined });
    const pong = await transport.ping();
    expect(pong.pythonVersion).toMatch(/^\d+\.\d+/);
    expect(pong.jupyterClientVersion).toMatch(/^\d+/);
    expect(pong.ipykernelVersion).toMatch(/^\d+/);
    await transport.shutdownAll();
    expect(transport.alive).toBe(false);
  });

  it('starts a kernel, executes cells and maps outputs (I1 core behavior)', async () => {
    const session = await registry.getOrCreate({
      notebookPath,
      interpreterPath: interpreter,
      kernelSpecName: 'python3',
      language: 'python',
    });
    expect(session.kernelId).toMatch(/^kernel-\d+$/);
    expect(session.pid).not.toBeNull();

    const ok = await registry.execCell(notebookPath, {
      code: 'print("hello")\n42',
      silent: false,
      storeOutputs: true,
      timeoutMs: 60_000,
    });
    expect(ok.result.status).toBe('ok');
    expect(ok.result.executionCount).toBe(1);
    const stream = ok.result.rawOutputs.find((o) => o.outputType === 'stream');
    expect(stream).toMatchObject({ outputType: 'stream', name: 'stdout', text: 'hello\n' });
    const result = ok.result.rawOutputs.find((o) => o.outputType === 'execute_result');
    expect(result?.data?.['text/plain']).toBe('42');

    // Cell-level exceptions are domain results, not tool errors (D10).
    const err = await registry.execCell(notebookPath, {
      code: 'raise ValueError("boom")',
      silent: false,
      storeOutputs: true,
      timeoutMs: 60_000,
    });
    expect(err.result.status).toBe('error');
    expect(err.result.rawOutputs[0]).toMatchObject({ outputType: 'error', ename: 'ValueError' });
    expect(err.session.executionCount).toBe(2);
  });

  it('silent cells produce no outputs and do not bump execution_count', async () => {
    const before = (await registry.findByNotebook(notebookPath))!.executionCount;
    const silent = await registry.execCell(notebookPath, {
      code: 'x = 1',
      silent: true,
      storeOutputs: false,
      timeoutMs: 60_000,
    });
    expect(silent.result.rawOutputs).toEqual([]);
    expect(silent.result.status).toBe('ok');
    expect(silent.session.executionCount).toBe(before);
  });

  it('interrupts a long-running cell (I5 path: interrupt -> error with KeyboardInterrupt)', async () => {
    const result = await registry.execCell(notebookPath, {
      code: 'import time\nwhile True:\n    time.sleep(0.1)',
      silent: false,
      storeOutputs: true,
      timeoutMs: 2_500,
    });
    // Either the interrupt lands (status error, KeyboardInterrupt) or the
    // kernel cannot be interrupted (status timeout) — both are acceptable
    // per SPEC §5.8; a hang would fail the test timeout.
    expect(['error', 'timeout']).toContain(result.result.status);
    if (result.result.status === 'error') {
      expect(result.result.rawOutputs[0]).toMatchObject({ ename: 'KeyboardInterrupt' });
    }
  }, 120_000);

  it('kernel status reports aliveness (I9 prerequisite)', async () => {
    const session = await registry.findByNotebook(notebookPath);
    expect(session).not.toBeNull();
    expect(session!.alive).toBe(true);
  });

  it('[I9] restart gives a new kernel id and runs no cells', async () => {
    const oldSession = (await registry.findByNotebook(notebookPath))!;
    // Falsifiable evidence that nothing ran on the FRESH kernel: execute a cell
    // that would leave a marker in the kernel's namespace, then restart and
    // read that name back. An empty kernel raises NameError (a domain result,
    // not a tool error); a reused one would print the old value. This replaces
    // `executionCount === null`, which was true by construction because only
    // execCell ever writes that field (review v3 TST-6).
    await registry.execCell(notebookPath, {
      code: 'restart_marker = "ran-before-restart"',
      silent: true,
      storeOutputs: false,
      timeoutMs: 60_000,
    });

    const newSession = await registry.restart(notebookPath);
    expect(newSession).not.toBeNull();
    expect(newSession!.kernelId).not.toBe(oldSession.kernelId);
    expect(newSession!.alive).toBe(true);
    expect(newSession!.executionCount).toBeNull();

    const probe = await registry.execCell(notebookPath, {
      code: 'print(restart_marker)',
      silent: false,
      storeOutputs: true,
      timeoutMs: 60_000,
    });
    expect(probe.result.status).toBe('error');
    expect(probe.result.rawOutputs[0]).toMatchObject({ outputType: 'error', ename: 'NameError' });

    const current = (await registry.findByNotebook(notebookPath))!;
    expect(current.kernelId).toBe(newSession!.kernelId);
  });

  it('rejects concurrent executions on the same kernel with kernel_busy (I10)', async () => {
    const first = registry.execCell(notebookPath, {
      code: 'import time\ntime.sleep(3)',
      silent: true,
      storeOutputs: false,
      timeoutMs: 60_000,
    });
    // Give the first request a moment to register as in-flight.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(
      registry.execCell(notebookPath, {
        code: '1',
        silent: true,
        storeOutputs: false,
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'kernel_busy' });
    await first;
  }, 120_000);
});

describe('[I11] no orphan sidecar/kernel processes after shutdown', () => {
  it('kills all spawned processes', async () => {
    // Self-contained (review D6): this case spawns the processes it checks, so
    // running it alone (vitest -t '[I11]') cannot degrade into an empty loop
    // that passes vacuously. It also asserts the checked set is non-empty.
    const transport = new SidecarTransport({ interpreterPath: interpreter, onLog: () => undefined });
    const ownSidecarPid = transport.pid ?? -1;
    expect(ownSidecarPid).toBeGreaterThan(0);
    await transport.startKernel({
      kernelId: 'i11-kernel',
      interpreterPath: interpreter,
      kernelSpecName: 'python3',
      language: 'python',
    });

    const session = await registry.getOrCreate({
      notebookPath,
      interpreterPath: interpreter,
      kernelSpecName: 'python3',
      language: 'python',
    });
    const pid = session.pid;
    expect(pid).not.toBeNull();

    await registry.shutdownAll();
    await transport.shutdownAll();
    expect(registry.listKernels()).toEqual([]);

    // Give the OS a moment to reap the trees.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const checked = [pid, ownSidecarPid].filter((value): value is number => typeof value === 'number' && value > 0);
    expect(checked.length).toBeGreaterThanOrEqual(2); // guards the vacuous-pass shape
    for (const candidate of checked) {
      expect(processExists(candidate)).toBe(false);
    }
  }, 120_000);
});

describe('[A12] a kernel killed mid-run fails fast with kernel_died', () => {
  it('reports kernel_died within the iopub poll interval, not the full timeout', async () => {
    const session = await registry.getOrCreate({
      notebookPath,
      interpreterPath: interpreter,
      kernelSpecName: 'python3',
      language: 'python',
    });
    const pid = session.pid;
    expect(pid).not.toBeNull();

    // Start a 60s cell, then kill the kernel process tree externally
    // (simulating OOM): the sidecar must notice within its 5s iopub poll
    // instead of holding the request until the 60s timeout.
    const inflight = registry.execCell(notebookPath, {
      code: 'import time\ntime.sleep(60)',
      silent: false,
      storeOutputs: true,
      timeoutMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process');
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid!, 'SIGKILL');
    }

    const started = Date.now();
    await expect(inflight).rejects.toMatchObject({ code: 'kernel_died' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000); // << 60s timeout; poll interval is 5s
  }, 120_000);
});
