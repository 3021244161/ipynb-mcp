// Kernel lifecycle regressions (review v2 R1/R2/R3/V4/W5/W8). These drive the
// REAL KernelRegistry against a fake transport: no kernel, no Python, and each
// case pins one recovery path that the integration suite only covered by name.
//
// SPEC anchors: §5.3 (sidecar/kernel lifecycle, idle reclamation), §4.8
// (kernel termination vs in-flight runs), §10.2 I10 (run-level lock).

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/log.js';
import { IpynbError } from '../../src/core/errors.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import type {
  AnalyzeResult,
  ExecCellParams,
  ExecCellResult,
  KernelStatusResult,
  KernelTransport,
  PingResult,
  StartKernelParams,
  StartKernelResult,
} from '../../src/kernel/transport.js';

const NOTEBOOK = 'C:/work/nb.ipynb';
const INTERPRETER = 'C:/python/python.exe';

/** Minimal transport whose failure modes each case can steer. */
class FakeTransport implements KernelTransport {
  alive = true;
  shutdownCalls = 0;
  startCalls = 0;
  statusQuery: () => Promise<KernelStatusResult> = () =>
    Promise.resolve({ alive: true, executionCount: 1, pid: 4242 });
  #died: ((kernelId: string) => void) | null = null;

  constructor(private readonly failure: { onShutdown?: () => void; onStart?: () => void } = {}) {}

  ping(): Promise<PingResult> {
    return Promise.resolve({ pythonVersion: '3', jupyterClientVersion: '8', ipykernelVersion: '6' });
  }

  startKernel(params: StartKernelParams): Promise<StartKernelResult> {
    this.startCalls += 1;
    this.failure.onStart?.();
    return Promise.resolve({ pid: 4242, kernelSpecName: params.kernelSpecName, language: params.language });
  }

  execCell(params: ExecCellParams): Promise<ExecCellResult> {
    void params;
    return Promise.resolve({ status: 'ok', executionCount: 1, rawOutputs: [], durationMs: 1 });
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  shutdownKernel(): Promise<void> {
    this.shutdownCalls += 1;
    // Matches the real transport: a dead sidecar rejects immediately.
    if (!this.alive) {
      return Promise.reject(new Error('sidecar is not running'));
    }
    this.failure.onShutdown?.();
    return Promise.resolve();
  }

  kernelStatus(): Promise<KernelStatusResult> {
    return this.statusQuery();
  }

  analyze(): Promise<AnalyzeResult> {
    return Promise.resolve({ ok: true, failedCellIndexes: [], defs: [], uses: [] });
  }

  shutdownAll(): Promise<void> {
    return Promise.resolve();
  }

  onKernelDied(callback: (kernelId: string) => void): void {
    this.#died = callback;
  }

  /** Simulate the sidecar's kernel_died event. */
  emitKernelDied(kernelId: string): void {
    this.#died?.(kernelId);
  }
}

/** The pieces of SidecarTransport the registry actually depends on. */
interface FakeSidecar {
  readonly transport: FakeTransport;
  readonly options: { onExit?: (reason: string) => void };
}

function makeSidecar(
  failure: { onShutdown?: () => void; onStart?: () => void } = {},
): FakeSidecar {
  const sidecar = {
    options: {} as { onExit?: (reason: string) => void },
    transport: new FakeTransport(failure),
  };
  return sidecar;
}

function registryWith(
  sidecar: FakeSidecar,
  overrides: Partial<ConstructorParameters<typeof KernelRegistry>[0]> = {},
): KernelRegistry {
  return new KernelRegistry({
    idleSeconds: 3600,
    transportFactory: (options) => {
      // The registry passes its onExit hook through the factory options, which
      // is how a crashed sidecar reaches the session cleanup (review V4).
      sidecar.options.onExit = options.onExit;
      return sidecar.transport;
    },
    ...overrides,
  });
}

function createInput(): {
  notebookPath: string;
  interpreterPath: string;
  kernelSpecName: string;
  language: string;
  fresh?: boolean;
} {
  return {
    notebookPath: NOTEBOOK,
    interpreterPath: INTERPRETER,
    kernelSpecName: 'python3',
    language: 'python',
  };
}

describe('[R1] a session whose sidecar died is dropped, not kept forever', () => {
  it('recovers on the NEXT call when the dead session is still registered', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    const first = await registry.getOrCreate(createInput());
    expect(first.kernelId).toBe('kernel-1');

    // The sidecar process is gone; the session record is still in the map —
    // exactly the state that used to make this notebook permanently unrunnable
    // (getOrCreate -> shutdown -> kernel_died, session kept, repeat forever).
    sidecar.transport.alive = false;

    const second = await registry.getOrCreate(createInput());
    expect(second.kernelId).toBe('kernel-2');
    expect(sidecar.transport.startCalls).toBe(2);
  });

  it('shutdown() on a dead transport is a no-op, never a permanent kernel_died', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());
    sidecar.transport.alive = false;

    await expect(registry.shutdown(NOTEBOOK)).resolves.toBeUndefined();
    // Idempotent: the session is already gone, so calling again also succeeds.
    await expect(registry.shutdown(NOTEBOOK)).resolves.toBeUndefined();
    expect(registry.findByNotebook(NOTEBOOK)).toBeNull();
    expect(sidecar.transport.shutdownCalls).toBe(0);
  });

  it('a shutdownKernel failure reports kernel_died but keeps the session for a retry', async () => {
    let wedged = true;
    const sidecar = makeSidecar({
      onShutdown: () => {
        if (wedged) {
          throw new Error('transport is wedged');
        }
      },
    });
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    await expect(registry.shutdown(NOTEBOOK)).rejects.toMatchObject({ code: 'kernel_died' });
    // A30: the kernel is still out there, so the session must stay registered
    // for the final shutdown_all / a retry.
    expect(registry.findByNotebook(NOTEBOOK)).not.toBeNull();

    // And a retry that succeeds cleans up, so this is never a dead end (R1).
    wedged = false;
    await expect(registry.shutdown(NOTEBOOK)).resolves.toBeUndefined();
    expect(registry.findByNotebook(NOTEBOOK)).toBeNull();

    const restarted = await registry.getOrCreate(createInput());
    expect(restarted.kernelId).toBe('kernel-2');
  });

  it('an onExit notification drops the sessions the dead sidecar hosted', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());
    expect(registry.listKernels()).toHaveLength(1);

    // This is what SidecarTransport calls when its process dies (review V4).
    sidecar.options.onExit?.('sidecar exited (code=1, signal=null)');
    expect(registry.listKernels()).toEqual([]);

    const restarted = await registry.getOrCreate(createInput());
    expect(restarted.kernelId).toBe('kernel-2');
  });
});

describe('[R2] idle reclamation never propagates its failure', () => {
  it('swallows a failed shutdown and keeps the session for the next tick', async () => {
    const sidecar = makeSidecar({
      onShutdown: () => {
        throw new Error('cannot reach the kernel');
      },
    });
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const warnings: string[] = [];
    const registry = registryWith(sidecar, {
      idleSeconds: 1,
      now: () => new Date(clock),
      logger: createLogger('debug', (line) => warnings.push(line)),
    });
    await registry.getOrCreate(createInput());

    clock += 5_000; // past idleSeconds
    // The rejection must not escape: this is the code the void-ed timer runs.
    await expect(registry.reclaimIdle()).resolves.toBeUndefined();
    expect(registry.findByNotebook(NOTEBOOK)).not.toBeNull();
    expect(warnings.some((line) => line.includes('idle reclamation'))).toBe(true);
  });

  it('a successful reclamation removes the session', async () => {
    const sidecar = makeSidecar();
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const registry = registryWith(sidecar, { idleSeconds: 1, now: () => new Date(clock) });
    await registry.getOrCreate(createInput());

    clock += 5_000;
    await registry.reclaimIdle();
    expect(registry.findByNotebook(NOTEBOOK)).toBeNull();
    expect(sidecar.transport.shutdownCalls).toBe(1);
  });
});

describe('[R3] kernel termination reaches the runs waiting on it', () => {
  it('fires registered abort sinks when the kernel dies', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    let aborts = 0;
    const unregister = registry.onRunAbort(NOTEBOOK, () => {
      aborts += 1;
    });
    sidecar.transport.emitKernelDied('kernel-1');
    expect(aborts).toBe(1);

    // Unregistered sinks stay silent (the run already finished).
    unregister();
    sidecar.transport.emitKernelDied('kernel-1');
    expect(aborts).toBe(1);
  });

  it('fires abort sinks when the kernel dies unexpectedly', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    let aborts = 0;
    registry.onRunAbort(NOTEBOOK, () => {
      aborts += 1;
    });

    sidecar.transport.emitKernelDied('kernel-1');
    expect(aborts).toBe(1);
    expect(registry.findByNotebook(NOTEBOOK)).toBeNull();
  });

  it('does not fire abort sinks for a session the registry itself replaces', async () => {
    // getOrCreate(fresh) and shutdown are used by the very run that is asking
    // for the replacement (replay) and by notebook_kernel, which aborts its
    // runs itself: notifying here would abort the replacement run before its
    // first cell (SPEC §4.7 rule 5).
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    let aborts = 0;
    registry.onRunAbort(NOTEBOOK, () => {
      aborts += 1;
    });

    await registry.shutdown(NOTEBOOK);
    await registry.getOrCreate(createInput());
    await registry.restart(NOTEBOOK);
    expect(aborts).toBe(0);
  });

  it('fires abort sinks when the sidecar exits mid-run', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    let aborts = 0;
    registry.onRunAbort(NOTEBOOK, () => {
      aborts += 1;
    });
    sidecar.transport.alive = false;
    sidecar.options.onExit?.('sidecar exited (code=1, signal=null)');
    expect(aborts).toBe(1);
  });
});

describe('[W5] the run-level lock survives a session swap', () => {
  it('kernel_busy fires with NO exec in flight (the gap between two cells)', async () => {
    // This is the half of I10 the integration suite cannot drive: the lock is
    // held for the WHOLE run, so a call arriving while no cell is executing must
    // still be refused (D-019; the old lock lived on the session object and
    // evaporated as soon as the session was replaced).
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    const release = registry.acquireRun(NOTEBOOK);
    // No execCell call anywhere: session.busy is false.
    let busy: unknown = null;
    try {
      registry.acquireRun(NOTEBOOK);
    } catch (cause) {
      busy = cause;
    }
    expect(busy).toMatchObject({ code: 'kernel_busy' });
    release();
    const next = registry.acquireRun(NOTEBOOK);
    next();
  });

  it('kernel_busy still fires after restart replaces the session object', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    const release = registry.acquireRun(NOTEBOOK);
    await registry.restart(NOTEBOOK);
    let busy: unknown = null;
    try {
      registry.acquireRun(NOTEBOOK);
    } catch (cause) {
      busy = cause;
    }
    expect(busy).toMatchObject({ code: 'kernel_busy' });

    // ...and the lock is released afterwards.
    release();
    const next = registry.acquireRun(NOTEBOOK);
    next();
  });

  it('acquiring without any kernel raises kernel_not_available', () => {
    const registry = registryWith(makeSidecar());
    expect(() => registry.acquireRun(NOTEBOOK)).toThrow(
      expect.objectContaining({ code: 'kernel_not_available' }),
    );
  });
});

describe('[W8] a failed kernel_status query is not reported as a dead kernel', () => {
  it('keeps the transport-derived alive value and logs the failure', async () => {
    const sidecar = makeSidecar();
    const logged: string[] = [];
    const registry = registryWith(sidecar, {
      logger: createLogger('debug', (line) => logged.push(line)),
    });
    await registry.getOrCreate(createInput());
    sidecar.transport.statusQuery = () => Promise.reject(new Error('sidecar is busy'));

    const kernels = await registry.listKernelsWithStatus();
    expect(kernels[0]!.alive).toBe(true);
    expect(logged.some((line) => line.includes('kernel_status query failed'))).toBe(true);
  });
});

describe('[W8] a missing session fails fast instead of hanging', () => {
  it('execCell without a session raises kernel_not_available', async () => {
    const registry = registryWith(makeSidecar());
    await expect(
      registry.execCell(NOTEBOOK, { code: 'x = 1', silent: true, storeOutputs: false, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(IpynbError);
  });
});

describe('[ROB-2] a timed-out cell actually shuts its kernel down', () => {
  it('calls shutdownKernel exactly once and leaves no session behind', async () => {
    const sidecar = makeSidecar();
    sidecar.transport.execCell = () =>
      Promise.resolve({ status: 'timeout', executionCount: null, rawOutputs: [], durationMs: 5 });
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    const result = await registry.execCell(NOTEBOOK, {
      code: 'while True: pass',
      silent: false,
      storeOutputs: true,
      timeoutMs: 10,
    });
    expect(result.result.status).toBe('timeout');
    // SPEC §4.7 rule 6: timeout kills the kernel. Removing the session first
    // made shutdown() find nothing and return, so the process stayed alive
    // while the registry forgot it (review v3 ROB-2 — 0 calls, kernel leaked).
    expect(sidecar.transport.shutdownCalls).toBe(1);
    expect(registry.findByNotebook(NOTEBOOK)).toBeNull();

    // …and the next run starts ONE new kernel rather than coexisting with the
    // old one under the same reuse key (SPEC §5.3).
    const next = await registry.getOrCreate(createInput());
    expect(next.kernelId).toBe('kernel-2');
    expect(registry.listKernels()).toHaveLength(1);
  });

  it('removes the session even when the shutdown call itself fails', async () => {
    const sidecar = makeSidecar({
      onShutdown: () => {
        throw new Error('sidecar is wedged');
      },
    });
    sidecar.transport.execCell = () =>
      Promise.resolve({ status: 'timeout', executionCount: null, rawOutputs: [], durationMs: 5 });
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());

    await registry.execCell(NOTEBOOK, {
      code: 'while True: pass',
      silent: false,
      storeOutputs: true,
      timeoutMs: 10,
    });
    // The timeout result still wins (A30), but a kernel we cannot close must
    // not stay registered as if it were usable.
    expect(registry.findByNotebook(NOTEBOOK)).toBeNull();
  });
});

describe('[ROB-6] path identity resolves symlinks before keying', () => {
  it('treats two spellings of one file as one kernel and one run lock', async () => {
    const sidecar = makeSidecar();
    const canonical = 'C:/real/nb.ipynb';
    const viaLink = 'C:/link/nb.ipynb';
    const registry = registryWith(sidecar, {
      canonicalPath: (target) => (target === viaLink ? canonical : target),
    });

    const first = await registry.getOrCreate({ ...createInput(), notebookPath: canonical });
    const second = await registry.getOrCreate({ ...createInput(), notebookPath: viaLink });
    expect(second.kernelId).toBe(first.kernelId);
    expect(sidecar.transport.startCalls).toBe(1);

    // The run lock follows the same identity: a second run through the link is
    // refused while the canonical spelling holds it (SPEC §5.3).
    const release = registry.acquireRun(canonical);
    expect(() => registry.acquireRun(viaLink)).toThrow(
      expect.objectContaining({ code: 'kernel_busy' }),
    );
    release();
  });

  it('falls back to the literal spelling when the path cannot be resolved', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar, {
      canonicalPath: () => {
        throw new Error('ENOENT');
      },
    });
    const session = await registry.getOrCreate(createInput());
    expect(session.kernelId).toBe('kernel-1');
  });
});

describe('[ROB-13] a kernel reported dead is still asked to shut down', () => {
  it('calls shutdownKernel so a wrong alive:false cannot orphan a live process', async () => {
    const sidecar = makeSidecar();
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());
    // The probe now says "dead" (an unstable/false answer): the kernel must not
    // simply be forgotten while its process keeps running (R19).
    sidecar.transport.statusQuery = () => Promise.resolve({ alive: false, executionCount: null, pid: null });

    const next = await registry.getOrCreate(createInput());
    expect(sidecar.transport.shutdownCalls).toBe(1);
    expect(next.kernelId).toBe('kernel-2');
  });
});

describe('[ROB-14] one probe decides the mode and the reuse', () => {
  it('liveKernel answers with the kernel id and getOrCreate reuses it without probing again', async () => {
    const sidecar = makeSidecar();
    let probes = 0;
    const registry = registryWith(sidecar);
    await registry.getOrCreate(createInput());
    const originalStatus = sidecar.transport.statusQuery;
    sidecar.transport.statusQuery = () => {
      probes += 1;
      return originalStatus();
    };

    const live = await registry.liveKernel(NOTEBOOK);
    expect(live).toEqual({ kernelId: 'kernel-1' });
    expect(probes).toBe(1);

    // The run hands that answer to getOrCreate, so no second round-trip — and
    // no window in which the two answers could disagree.
    const session = await registry.getOrCreate({ ...createInput(), knownAlive: true });
    expect(session.kernelId).toBe('kernel-1');
    expect(probes).toBe(1);
  });
});
