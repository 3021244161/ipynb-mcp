// Integration tests (step 7a): real sidecar + real kernel.
// Requires an interpreter with ipykernel; provide it via IPYNB_TEST_PYTHON
// (defaults to the PATH python). A dedicated test venv is created from that
// base so the user's environment is never touched (AGENTS §3).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/log.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENV_DIR = path.join(REPO_ROOT, 'tests', '.venv-test');
const WINDOWS = process.platform === 'win32';
const VENV_PY = WINDOWS
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');

const BASE_PYTHON = process.env['IPYNB_TEST_PYTHON'] ?? (WINDOWS ? 'python' : 'python3');

let workspace: string;
let notebookPath: string;
let registry: KernelRegistry;

beforeAll(async () => {
  if (!existsSync(VENV_PY)) {
    execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', VENV_DIR], {
      stdio: 'inherit',
      timeout: 120_000,
    });
  }
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-kernel-'));
  notebookPath = path.join(workspace, 'nb.ipynb');
  await writeFile(notebookPath, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
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
    const transport = new SidecarTransport({ interpreterPath: VENV_PY, onLog: () => undefined });
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
      interpreterPath: VENV_PY,
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

  it('restart gives a new kernel id and runs no cells (I9)', async () => {
    const oldSession = (await registry.findByNotebook(notebookPath))!;
    const newSession = await registry.restart(notebookPath);
    expect(newSession).not.toBeNull();
    expect(newSession!.kernelId).not.toBe(oldSession.kernelId);
    // The name is the assertion (review D4): restart must NOT execute anything.
    // A fresh kernel reports no execution count and holds none of the old
    // state, and the session's own counter starts empty.
    expect(newSession!.executionCount).toBeNull();
    expect(newSession!.alive).toBe(true);
    // Prove freshness without executing a cell: a variable from the previous
    // kernel is gone (documented as not-runnable here because a real check
    // would itself be an execution — the counter assertions above are the
    // observable contract).
    const current = (await registry.findByNotebook(notebookPath))!;
    expect(current.kernelId).toBe(newSession!.kernelId);
    expect(current.executionCount).toBeNull();
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
    const transport = new SidecarTransport({ interpreterPath: VENV_PY, onLog: () => undefined });
    const ownSidecarPid = transport.pid ?? -1;
    expect(ownSidecarPid).toBeGreaterThan(0);
    await transport.startKernel({
      kernelId: 'i11-kernel',
      interpreterPath: VENV_PY,
      kernelSpecName: 'python3',
      language: 'python',
    });

    const session = await registry.getOrCreate({
      notebookPath,
      interpreterPath: VENV_PY,
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
      interpreterPath: VENV_PY,
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
