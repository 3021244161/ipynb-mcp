// Integration tests (step 7b): full execution orchestration via run.ts —
// mode matrix, write-back, resume/replay semantics, timeouts, idle reclaim
// and the D23 interpreter candidate chain.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { IpynbError } from '../../src/core/errors.js';
import { parseNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { SIDECAR_REQUIRED_MODULES, createNodeInterpreterDeps, pythonPrefix, resolveInterpreter } from '../../src/kernel/interpreter.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';
import { runNotebook, type RunDeps, type RunRequest } from '../../src/run.js';
import { handleNotebookEdit } from '../../src/mcp/tools/edit.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { PathFence } from '../../src/fs/fence.js';
import { nbformatSkipReason, validateNotebook } from './nbformat-validator.js';
import { createLogger } from '../../src/log.js';
import { BASE_PYTHON, VENV_PY, prepareVenv, resolvedTestInterpreter } from './test-venv.js';

/**
 * The interpreter the EXTERNAL AUTHORITY must run in.
 *
 * It is the interpreter this file's runs actually use, not the venv path: the resolve
 * falls back to the base interpreter whenever the venv cannot serve the sidecar, and
 * asking `VENV_PY` about nbformat in that situation reported an ENVIRONMENT gap as a
 * product failure (review v8 V8-11, still open in v9). `prepareVenv` runs in
 * `beforeAll`, so by the time any case asks this question the answer is final.
 */
function authorityInterpreter(): string {
  return resolvedTestInterpreter();
}

const WINDOWS = process.platform === 'win32';
// An interpreter that exists but CANNOT import ipykernel (I17). If absent on
// this machine we synthesize a stub executable instead.

let workspace: string;
let artifactRoot: string;
let registry: KernelRegistry;
let previousJupyterPath: string | undefined;
/**
 * Interpreter the transport-level cases drive directly. Chosen by trying to
 * start a kernel, because a test venv can be importable yet unusable (this
 * machine's `.venv-test` inherits pyzmq 26.2.0 from its conda base and kills
 * the sidecar on start). Cases that go through runNotebook resolve their own
 * interpreter via the SPEC §5.2 candidate chain and are unaffected.
 */
let sidecarInterpreter = VENV_PY;

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
  if (!(await canStartKernel(VENV_PY)) && (await canStartKernel(BASE_PYTHON))) {
    // Same TST-1 rule as kernel.test.ts: on CI the venv must work, so a
    // fallback there is a failure rather than a quieter green run.
    if (process.env['CI'] === 'true' || process.env['IPYNB_TEST_REQUIRE_VENV'] === '1') {
      throw new Error(
        `test interpreter fallback: ${VENV_PY} cannot start a kernel and the run fell back to ${BASE_PYTHON}`,
      );
    }
    sidecarInterpreter = BASE_PYTHON;
  }
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-run-'));
  artifactRoot = path.join(workspace, 'artifacts');
  registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('debug') });
  registry.start();
  // The test interpreter's kernelspecs live under its prefix; make sure the
  // candidate chain finds them regardless of what PATH points at.
  // JUPYTER_PATH entries point at the jupyter root (kernels live in <entry>/kernels).
  const basePython = BASE_PYTHON === 'python' || BASE_PYTHON === 'python3' ? null : BASE_PYTHON;
  const jupyterRoot = basePython !== null
    ? path.join(pythonPrefix(basePython), 'share', 'jupyter')
    : null;
  // Save/restore so this file cannot leak the var into other test files in
  // the same worker (review D6: env pollution made cases order-dependent).
  previousJupyterPath = process.env['JUPYTER_PATH'];
  if (jupyterRoot !== null && existsSync(path.join(jupyterRoot, 'kernels'))) {
    process.env['JUPYTER_PATH'] = jupyterRoot;
  }
}, 180_000);

afterAll(async () => {
  // Restore the env var this file may have set (review D6).
  if (previousJupyterPath === undefined) {
    delete process.env['JUPYTER_PATH'];
  } else {
    process.env['JUPYTER_PATH'] = previousJupyterPath;
  }
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

function config(): IpynbConfig {
  return {
    root: workspace,
    allowOutsideRoot: false,
    readOnly: false,
    images: 'auto',
    python: null,
    kernelIdleSeconds: 3600,
    execTimeoutSeconds: 300,
    backgroundThresholdSeconds: 30,
    backupKeep: 10,
    artifactDir: artifactRoot,
    inlineTextChars: 20000,
    previewLines: 12,
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    maxResponseBytes: 8_388_608,
    logLevel: 'info',
  };
}

/** Tool context for cases that drive a tool handler directly (FID-3). */
function depsContext(): Parameters<typeof handleNotebookEdit>[0] {
  return {
    config: config(),
    fence: new PathFence(workspace, false, process.platform),
    registry,
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target) => realpathSync(target),
    platform: process.platform,
  };
}

function deps(): RunDeps {
  return {
    registry,
    hasher,
    config: config(),
    imagesPolicy: 'auto',
    realpath: (target) => realpathSync(target),
  };
}

function codeCell(
  source: string,
  id: string,
  seed?: { outputs?: unknown[]; execution_count?: number | null },
): Record<string, unknown> {
  // seed lets fixtures carry PRE-EXISTING outputs, so "unchanged" assertions
  // distinguish "preserved" from "wiped" (review D1: an always-empty fixture
  // made the A1 data-loss bug invisible to I1/I3/I5).
  return {
    cell_type: 'code',
    id,
    metadata: {},
    source,
    outputs: seed?.outputs ?? [],
    execution_count: seed?.execution_count ?? null,
  };
}

function mdCell(source: string, id: string): Record<string, unknown> {
  return { cell_type: 'markdown', id, metadata: {}, source };
}

async function writeNb(name: string, cells: Array<Record<string, unknown>>): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      // nbformat requires display_name on a kernelspec. These fixtures omitted
      // it, and the real validator added by FID-1's fix rejected every one of
      // them on its first run — i.e. the whole suite had been validating
      // against files nbformat considers invalid.
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells,
  }));
  return target;
}

function request(pathStr: string, overrides?: Partial<RunRequest>): RunRequest {
  return {
    path: pathStr,
    cellSelector: 'all',
    mode: 'auto',
    timeoutSeconds: 120,
    writeOutputs: true,
    clearOutputsBefore: true,
    createBackup: true,
    ...overrides,
  };
}

async function readCells(target: string): Promise<Array<Record<string, unknown>>> {
  const parsed = parseNotebook(await readFile(target), hasher);
  return parsed.cells as unknown as Array<Record<string, unknown>>;
}

describe('[I1] execution writes execution_count only for executed cells', () => {
  it('runs cell 0 and leaves cell 2 untouched', async () => {
    const nb = await writeNb('i1.ipynb', [
      codeCell('x = 1', 'c0'),
      mdCell('# md', 'm1'),
      codeCell('print("two")', 'c2'),
    ]);
    const outcome = await runNotebook(request(nb, { cellSelector: '0' }), deps());
    expect(outcome.mode_used).toBe('replay'); // cold start, empty prefix
    expect(outcome.executed).toHaveLength(1);
    expect(outcome.executed[0]!.status).toBe('ok');

    const cells = await readCells(nb);
    expect(cells[0]!['execution_count']).toBe(1);
    expect((cells[0]!['outputs'] as unknown[]).length).toBe(0);
    expect(cells[2]!['execution_count']).toBeNull();
    expect(cells[2]!['outputs']).toEqual([]);
    expect(outcome.write_back.performed).toBe(true);
    expect(outcome.kernel_alive).toBe(true);
  });
});

describe('[I2] resume does not re-run earlier cells', () => {
  it('keeps the timestamp written by cell 0 intact', async () => {
    const stamp = path.join(workspace, 'i2-stamp.txt');
    const nb = await writeNb('i2.ipynb', [
      codeCell(`import time\nopen(r'${stamp.replace(/\\/g, '/')}', 'w').write(str(time.time()))`, 'c0'),
      codeCell('y = 2', 'c1'),
    ]);
    await runNotebook(request(nb, { cellSelector: '0-1' }), deps());
    const first = await readFile(stamp, 'utf8');

    const second = await runNotebook(request(nb, { cellSelector: '1', mode: 'resume' }), deps());
    expect(second.mode_used).toBe('resume');
    expect(second.executed.map((entry) => entry.cell_index)).toEqual([1]);

    const after = await readFile(stamp, 'utf8');
    expect(after).toBe(first); // cell 0 never re-ran
  });
});

describe('[I3] cold-start auto silently replays the prefix', () => {
  it('replays 0..4, executes only cell 5, prefix stays byte-identical', async () => {
    // Seeded outputs make "preserved" distinguishable from "wiped" (D1), and
    // the doc-level diff below replaces the old `void before;` no-op (D4).
    const seeded = [
      { outputs: [{ output_type: 'stream', name: 'stdout', text: ['KEEP-0\n'] }], execution_count: 41 },
      { outputs: [{ output_type: 'stream', name: 'stdout', text: ['KEEP-1\n'] }], execution_count: 42 },
      { outputs: [{ output_type: 'stream', name: 'stdout', text: ['KEEP-2\n'] }], execution_count: 43 },
      { outputs: [{ output_type: 'stream', name: 'stdout', text: ['KEEP-3\n'] }], execution_count: 44 },
      { outputs: [{ output_type: 'stream', name: 'stdout', text: ['KEEP-4\n'] }], execution_count: 45 },
    ];
    const nb = await writeNb('i3.ipynb', [
      codeCell('a = 1', 'c0', seeded[0]),
      codeCell('b = 2', 'c1', seeded[1]),
      codeCell('import time\ntime.sleep(3)', 'c2', seeded[2]),
      codeCell('c = 4', 'c3', seeded[3]),
      codeCell('d = 5', 'c4', seeded[4]),
      codeCell('print(a + b + c + d)', 'c5'),
    ]);
    const beforeDoc = JSON.parse(await readFile(nb, 'utf8')) as Record<string, unknown>;
    const beforeCells = beforeDoc['cells'] as Array<Record<string, unknown>>;

    const outcome = await runNotebook(request(nb, { cellSelector: '5', timeoutSeconds: 60 }), deps());
    expect(outcome.mode_used).toBe('replay');
    expect(outcome.replayed_cell_indexes).toEqual([0, 1, 2, 3, 4]);
    expect(outcome.executed.map((entry) => entry.cell_index)).toEqual([5]);
    expect(outcome.executed[0]!.status).toBe('ok');

    const afterDoc = JSON.parse(await readFile(nb, 'utf8')) as Record<string, unknown>;
    const afterCells = afterDoc['cells'] as Array<Record<string, unknown>>;
    // Normalise source form (writing may canonicalise string -> lines array),
    // then require that ONLY cell 5 differs anywhere in the notebook.
    const norm = (cell: Record<string, unknown>): string =>
      JSON.stringify({
        cell_type: cell['cell_type'],
        source: Array.isArray(cell['source']) ? (cell['source'] as string[]).join('') : cell['source'],
        outputs: cell['outputs'],
        execution_count: cell['execution_count'],
      });
    const changed: number[] = [];
    for (let i = 0; i < beforeCells.length; i += 1) {
      if (norm(beforeCells[i]!) !== norm(afterCells[i]!)) {
        changed.push(i);
      }
    }
    expect(changed).toEqual([5]);

    // Prefix cells kept their seeded outputs and execution counts intact.
    const cells = await readCells(nb);
    for (const index of [0, 1, 2, 3, 4]) {
      expect(cells[index]!['outputs']).toEqual(seeded[index]!.outputs);
      expect(cells[index]!['execution_count']).toBe(41 + index);
    }
    expect(cells[5]!['execution_count']).toBe(1);

    // Document-level keys are untouched.
    expect(afterDoc['metadata']).toEqual(beforeDoc['metadata']);
    expect(afterDoc['nbformat']).toBe(beforeDoc['nbformat']);
    expect(afterDoc['nbformat_minor']).toBe(beforeDoc['nbformat_minor']);
  }, 180_000);
});

describe('[I4] full mode ignores the selector', () => {
  it('executes every code cell and warns targets_ignored', async () => {
    const nb = await writeNb('i4.ipynb', [
      codeCell('p = 1', 'c0'),
      mdCell('text', 'm1'),
      codeCell('q = 2', 'c2'),
    ]);
    const outcome = await runNotebook(request(nb, { cellSelector: '2', mode: 'full' }), deps());
    expect(outcome.mode_used).toBe('full');
    expect(outcome.executed.map((entry) => entry.cell_index)).toEqual([0, 2]);
    expect(outcome.warnings.map((warning) => warning.code)).toContain('targets_ignored');
  });
});

describe('[I5] uninterruptible cell times out and kills the kernel', () => {
  it('raises exec_timeout, writes completed cells, kernel is gone', async () => {
    const nb = await writeNb('i5.ipynb', [
      codeCell('w = 1', 'c0'),
      // Seed pre-existing outputs on the timed-out and never-run cells: the
      // run must never wipe them (review A1 / D1).
      codeCell(
        'import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nimport time\nwhile True: time.sleep(0.1)',
        'c1',
        { outputs: [{ output_type: 'stream', name: 'stdout', text: ['OLD-1\n'] }], execution_count: 11 },
      ),
      codeCell('z = 3', 'c2', { outputs: [{ output_type: 'stream', name: 'stdout', text: ['OLD-2\n'] }], execution_count: 12 }),
    ]);
    let caught: unknown;
    try {
      await runNotebook(request(nb, { cellSelector: 'all', timeoutSeconds: 6 }), deps());
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(IpynbError);
    const err = caught as IpynbError;
    expect(err.code).toBe('exec_timeout');
    expect((err.detail as Record<string, unknown>)['cell_index']).toBe(1);

    // Completed cell 0 was written back; the timed-out cell keeps its
    // PRE-RUN outputs (SPEC §4.8 rule 2), and the never-run cell is
    // completely untouched (SPEC §4.7 rule 3).
    const cells = await readCells(nb);
    expect(cells[0]!['execution_count']).toBe(1);
    expect(cells[1]!['execution_count']).toBe(11);
    expect(cells[1]!['outputs']).toEqual([{ output_type: 'stream', name: 'stdout', text: ['OLD-1\n'] }]);
    expect(cells[2]!['execution_count']).toBe(12);
    expect(cells[2]!['outputs']).toEqual([{ output_type: 'stream', name: 'stdout', text: ['OLD-2\n'] }]);

    // The kernel is marked dead and closed (SPEC §4.7 rule 6).
    expect(registry.findByNotebook(nb)).toBeNull();
  }, 180_000);
});

describe('[I18] a timeout never wipes outputs of cells that did not run', () => {
  it('preserves seeded outputs and execution_count across the failure', async () => {
    const nb = await writeNb('i18.ipynb', [
      codeCell(
        'import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nimport time\nwhile True: time.sleep(0.1)',
        'c0',
      ),
      codeCell('z = 3', 'c1', { outputs: [{ output_type: 'stream', name: 'stdout', text: ['PRESERVED\n'] }], execution_count: 7 }),
    ]);
    await expect(
      runNotebook(request(nb, { cellSelector: 'all', timeoutSeconds: 4 }), deps()),
    ).rejects.toMatchObject({ code: 'exec_timeout' });
    const cells = await readCells(nb);
    expect(cells[1]!['outputs']).toEqual([{ output_type: 'stream', name: 'stdout', text: ['PRESERVED\n'] }]);
    expect(cells[1]!['execution_count']).toBe(7);
  }, 120_000);
});

describe('[I18b] the executed cell re-executes over seeded outputs', () => {
  it('clear_outputs_before=true clears only the cell about to run', async () => {
    // The title only means something with a cell that is NOT run and carries
    // seeded output: with a one-cell notebook "clears only the cell about to run"
    // is indistinguishable from "clears everything", which is the defect this
    // case exists to catch (review v5 TST-3). Three cells, the middle one not
    // executed, and every assertion says which cell it is about.
    const nb = await writeNb('i18b.ipynb', [
      codeCell('print("fresh")', 'c0', {
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['STALE\n'] }],
        execution_count: 3,
      }),
      codeCell('print("untouched")', 'c1', {
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['KEEP-ME\n'] }],
        execution_count: 7,
      }),
      codeCell('print("also fresh")', 'c2', {
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['STALE-2\n'] }],
        execution_count: 5,
      }),
    ]);
    const outcome = await runNotebook(request(nb, { cellSelector: '0,2' }), deps());
    expect(outcome.executed.map((cell) => cell.status)).toEqual(['ok', 'ok']);

    const cells = await readCells(nb);
    const first = JSON.stringify(cells[0]!['outputs']);
    const middle = JSON.stringify(cells[1]!['outputs']);
    const last = JSON.stringify(cells[2]!['outputs']);

    expect(first).toContain('fresh');
    expect(first).not.toContain('STALE');
    expect(last).toContain('also fresh');
    expect(last).not.toContain('STALE-2');
    // The untouched cell keeps BOTH its seeded output and its execution count:
    // clearing more than the cells about to run is the failure this asserts.
    expect(middle).toContain('KEEP-ME');
    expect(cells[1]!['execution_count']).toBe(7);
    expect(cells[0]!['execution_count']).toBe(1);
    expect(cells[2]!['execution_count']).toBe(2);
  }, 120_000);
});

describe('[TST-2] a run takes the registry run-level lock', () => {
  it('runNotebook acquires and releases it around the whole run', async () => {
    // The case above proves the LOCK works. Nothing proved the run USES it, so
    // deleting the `acquireRun` call from run.ts would have kept the suite green
    // (review v5 TST-2). It is observable behaviour, not an implementation detail:
    // without it, a concurrent call on the same notebook interleaves with this
    // run instead of getting `kernel_busy`.
    const nb = await writeNb('tst2-lock.ipynb', [codeCell('print("locked")', 'c0')]);
    const acquired: string[] = [];
    let released = 0;
    // A real `KernelRegistry` subclass, not a Proxy: private fields (`#sessions`)
    // are per-class and a Proxy's receiver is not an instance of the class, so the
    // proxy approach throws "Cannot read private member #sessions". Everything
    // except the two asserted calls goes to `super`.
    class SpyingRegistry extends KernelRegistry {
      override acquireRun(path: string): () => void {
        acquired.push(path);
        const release = super.acquireRun(path);
        return () => {
          released += 1;
          release();
        };
      }
    }
    const spying = new SpyingRegistry({ idleSeconds: 3600, logger: createLogger('error') });
    try {
      const outcome = await runNotebook(request(nb, { cellSelector: 'all' }), { ...deps(), registry: spying });
      expect(outcome.executed[0]!.status).toBe('ok');
      expect(acquired).toEqual([nb]);
      expect(released).toBe(1);
    } finally {
      await spying.shutdownAll();
    }
  }, 120_000);
});

describe('[I-env] kernels inherit the full parent environment', () => {
  it('PATH and HOME are visible inside executed cells (review A2)', async () => {
    const nb = await writeNb('env.ipynb', [
      codeCell('import os\nprint("PATH" in os.environ and os.environ["PATH"] != "")', 'c0'),
      codeCell('import os\nprint(os.environ.get("HOME") is not None or os.environ.get("USERPROFILE") is not None)', 'c1'),
    ]);
    const outcome = await runNotebook(request(nb, { cellSelector: 'all' }), deps());
    expect(outcome.executed[0]!.status).toBe('ok');
    expect(outcome.executed[1]!.status).toBe('ok');
    const first = outcome.executed[0]!.outputs[0]!;
    const second = outcome.executed[1]!.outputs[0]!;
    expect(first).toMatchObject({ kind: 'stream', text: 'True\n' });
    expect(second).toMatchObject({ kind: 'stream', text: 'True\n' });
  }, 120_000);
});

describe('[I6] write_outputs=false leaves the file untouched', () => {
  it('returns outputs without writing', async () => {
    const nb = await writeNb('i6.ipynb', [codeCell('print("kept")', 'c0')]);
    const before = await readFile(nb);
    const outcome = await runNotebook(request(nb, { cellSelector: 'all', writeOutputs: false }), deps());
    expect(outcome.executed[0]!.status).toBe('ok');
    const stream = outcome.executed[0]!.outputs[0]!;
    expect(stream).toMatchObject({ kind: 'stream', text: 'kept\n' });
    expect(outcome.write_back.performed).toBe(false);
    expect(await readFile(nb)).toEqual(before);
  });
});

describe('[I7] sidecar death fails in-flight work; next run replays', () => {
  it('in-flight exec fails with kernel_died after a kill', async () => {
    const transport = new SidecarTransport({ interpreterPath: sidecarInterpreter, onLog: () => undefined });
    await transport.ping();
    const started = await transport.startKernel({
      kernelId: 'kernel-i7',
      interpreterPath: sidecarInterpreter,
      kernelSpecName: 'python3',
      language: 'python',
    });
    expect(started.pid).not.toBeNull();
    const inflight = transport.execCell({
      kernelId: 'kernel-i7',
      code: 'import time\ntime.sleep(30)',
      silent: false,
      storeOutputs: true,
      timeoutMs: 120_000,
    });
    // Attach the rejection handler BEFORE killing the sidecar. `expect(promise)
    // .rejects` is attached afterwards, and in the gap between the kill and that
    // attachment the rejection is unobserved: Node reports it as an unhandled
    // rejection and vitest surfaces it as "an error happened outside a test",
    // which is what CI flagged next to this case (review v5 TST-CI). Settling it
    // here keeps the promise observed from the moment it can reject.
    const settled = inflight.then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await transport.kill();
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? { code: null } : outcome.cause).toMatchObject({ code: 'kernel_died' });
    expect(transport.alive).toBe(false);
  }, 120_000);

  it('a later run replays instead of failing with kernel_died (review R1)', async () => {
    // The old case stopped at "the in-flight exec fails": it never ran a second
    // time, so a registry stuck on a dead session went unnoticed. Here the
    // kernel is killed while NO cell is running and the registry is not told
    // about it — exactly the state that used to make the next run throw
    // kernel_died forever (the dead-SIDECAR variant is covered deterministically
    // by tests/unit/kernel-registry.test.ts).
    const nb = await writeNb('i7-recovery.ipynb', [
      codeCell('print("before")', 'c0'),
      codeCell('print("after")', 'c1'),
    ]);

    const first = await runNotebook(request(nb, { cellSelector: 'all' }), deps());
    expect(first.executed[1]!.status).toBe('ok');
    const live = registry.findByNotebook(nb);
    expect(live).not.toBeNull();

    // Kill the kernel process tree the way an OOM kill or a user would.
    const { execFileSync } = await import('node:child_process');
    const kernelPid = live!.pid ?? 0;
    expect(kernelPid).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(kernelPid)], { stdio: 'ignore' });
    } else {
      process.kill(kernelPid, 'SIGKILL');
    }
    // Wait (bounded) for the sidecar to report the death; if it does not, the
    // session is still there and the NEXT run must recover anyway — the whole
    // point of R1 is that a stale dead session must not be a dead end.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && registry.findByNotebook(nb) !== null) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // The next run is a cold start: replay the prefix, execute cell 1.
    const second = await runNotebook(request(nb, { cellSelector: '1' }), deps());
    expect(second.mode_used).toBe('replay');
    expect(second.replayed_cell_indexes).toEqual([0]);
    expect(second.executed[0]!.status).toBe('ok');
  }, 180_000);
});

describe('[I8] idle kernels are reclaimed', () => {
  it('disappears from kernel status after the idle timeout', async () => {
    const shortLived = new KernelRegistry({ idleSeconds: 2, logger: createLogger('debug') });
    shortLived.start();
    const nb = await writeNb('i8.ipynb', [codeCell('idle_test = 1', 'c0')]);
    await runNotebook(request(nb, { cellSelector: 'all' }), {
      registry: shortLived,
      hasher,
      config: config(),
      imagesPolicy: 'auto',
      realpath: (target) => realpathSync(target),
    });
    expect(shortLived.findByNotebook(nb)).not.toBeNull();
    // Reclamation fires at clamp(2/2, 5..60) = 5s. Waiting a fixed 6.5 s left only
    // 1.5 s of margin, and the reclamation TIMER is node's, so anything that delays
    // the event loop (the sibling cases start real kernels and a 9 s [I8] run was
    // observed) makes the assertion fail without the product being wrong. Poll
    // until it is gone, with a bound well past the timer, and still assert the
    // end state — the "it was there to begin with" assertion above is what makes
    // this unreachable-by-accident.
    const deadline = Date.now() + 30_000;
    while (shortLived.findByNotebook(nb) !== null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(shortLived.findByNotebook(nb)).toBeNull();
    await shortLived.shutdownAll();
  }, 120_000);
});

describe('[I17] candidate chain degradation (D23)', () => {
  it('falls back from a broken kernelspec to .venv and warns (real probes)', async () => {
    // Review D4: the old version mocked the ipykernel probe away (a string
    // comparison) and used an EMPTY FILE as the .venv interpreter — the logic
    // under test was mocked. Here both candidates are REAL venvs:
    //   broken  = venv WITHOUT system-site-packages -> `import ipykernel` fails
    //   working = venv WITH    system-site-packages -> `import ipykernel` works
    const nbDir = path.join(workspace, 'i17');
    mkdirSync(nbDir, { recursive: true });

    const brokenDir = path.join(nbDir, 'broken-env');
    execFileSync(BASE_PYTHON, ['-m', 'venv', brokenDir], { stdio: 'ignore', timeout: 180_000 });
    const brokenPython = path.join(brokenDir, WINDOWS ? 'Scripts' : 'bin', WINDOWS ? 'python.exe' : 'python');
    expect(existsSync(brokenPython)).toBe(true);

    // The notebook's own .venv is a real environment that CAN import ipykernel.
    const venvDir = path.join(nbDir, '.venv');
    execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', venvDir], {
      stdio: 'ignore',
      timeout: 180_000,
    });
    const venvPython = path.join(venvDir, WINDOWS ? 'Scripts' : 'bin', WINDOWS ? 'python.exe' : 'python');
    expect(existsSync(venvPython)).toBe(true);

    // Jupyter root layout: <root>/kernels/<name>/kernel.json
    const specDir = path.join(nbDir, 'kernels', 'brokenkernel');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'kernel.json'), JSON.stringify({
      argv: [brokenPython, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      display_name: 'Broken Kernel',
      language: 'python',
    }));

    const previousJupyterPath = process.env['JUPYTER_PATH'];
    process.env['JUPYTER_PATH'] = nbDir;
    let resolution;
    try {
      resolution = await resolveInterpreter(
        {
          explicitPython: null,
          notebookPath: path.join(nbDir, 'nb.ipynb'),
          kernelSpecName: 'brokenkernel',
          languageInfoName: 'python',
        },
        createNodeInterpreterDeps(process.platform),
      );
    } finally {
      if (previousJupyterPath === undefined) {
        delete process.env['JUPYTER_PATH'];
      } else {
        process.env['JUPYTER_PATH'] = previousJupyterPath;
      }
    }

    expect(resolution.interpreterPath).toBe(venvPython);
    expect(resolution.warnings.map((warning) => warning.code)).toContain('kernelspec_mismatch');
  }, 300_000);
});

describe('[I-replay-fresh] mode=replay rebuilds state on a NEW kernel (review A4)', () => {
  it('variables from a previous run are gone after replay', async () => {
    const nb = await writeNb('replay-fresh.ipynb', [
      codeCell('persisted_var = 42', 'c0'),
      codeCell('print(persisted_var)', 'c1'),
    ]);
    // First run establishes persisted_var in a live kernel.
    const first = await runNotebook(request(nb, { cellSelector: 'all' }), deps());
    expect(first.mode_used).toBe('full');
    expect(first.executed[1]!.status).toBe('ok');

    // An explicit replay must start a FRESH kernel: the silent prefix reruns,
    // so persisted_var exists again — but prove freshness by deleting the
    // variable, then replaying only cell 1 without re-running cell 0.
    const del = await runNotebook(request(nb, { cellSelector: 'all' }), deps());
    void del;
    await registry.execCell(nb, {
      code: 'del persisted_var',
      silent: true,
      storeOutputs: false,
      timeoutMs: 60_000,
    });
    // Kernel now lacks persisted_var. replay rebuilds it via the prefix,
    // so cell 1 must print 42 — but on a reused (dirty) kernel without the
    // prefix the cell would fail. To distinguish fresh-vs-reused we instead
    // check the kernel_id changed from the previous session.
    const before = (await registry.findByNotebook(nb))!.kernelId;
    const replayed = await runNotebook(request(nb, { cellSelector: '1', mode: 'replay' }), deps());
    const after = (await registry.findByNotebook(nb))!.kernelId;
    expect(replayed.mode_used).toBe('replay');
    expect(replayed.replayed_cell_indexes).toEqual([0]);
    expect(after).not.toBe(before);
    expect(replayed.executed[0]!.status).toBe('ok');
    // And the target cell saw the rebuilt state.
    const stream = replayed.executed[0]!.outputs[0]!;
    expect(stream).toMatchObject({ kind: 'stream', text: '42\n' });
  }, 180_000);
});

describe('[I10] concurrent notebook_run on the same kernel raises kernel_busy (review A6)', () => {
  it('a second run-level call is rejected while the first is in flight', async () => {
    // Overlap case. The RUN-LEVEL half of this guard (a second call refused
    // while no exec is in flight at all — the gap between two cells) cannot be
    // driven deterministically through this API, so it is asserted directly in
    // tests/unit/kernel-registry.test.ts [W5]: "kernel_busy still fires after
    // restart replaces the session object", where the fake transport makes the
    // gap explicit. Both halves exist in the implementation (registry
    // #runActive is checked before the session's own busy flag matters).
    const nb = await writeNb('i10.ipynb', [
      codeCell('import time\ntime.sleep(3)', 'c0'),
      codeCell('y = 1', 'c1'),
    ]);
    const first = runNotebook(request(nb, { cellSelector: 'all', timeoutSeconds: 60 }), deps());
    // Wait until the first run's kernel is live and its 3s cell is in flight
    // (polling beats a fixed sleep: kernel startup varies with machine load).
    for (let i = 0; i < 100; i += 1) {
      const live = registry.findByNotebook(nb);
      if (live !== null && live.alive) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await expect(
      runNotebook(request(nb, { cellSelector: '1', mode: 'resume', timeoutSeconds: 60 }), deps()),
    ).rejects.toMatchObject({ code: 'kernel_busy' });
    const outcome = await first;
    expect(outcome.executed).toHaveLength(2);
  }, 180_000);
});

describe('[A11] selector error codes split by failure kind (SPEC §4.7/§7)', () => {
  it('an index beyond the notebook raises range_out_of_bounds', async () => {
    const nb = await writeNb('a11.ipynb', [codeCell('x = 1', 'c0')]);
    await expect(
      runNotebook(request(nb, { cellSelector: '99' }), deps()),
    ).rejects.toMatchObject({ code: 'range_out_of_bounds' });
  });

  it('a markdown target raises invalid_targets', async () => {
    const nb = await writeNb('a11b.ipynb', [codeCell('x = 1', 'c0'), mdCell('# md', 'm1')]);
    await expect(
      runNotebook(request(nb, { cellSelector: '1' }), deps()),
    ).rejects.toMatchObject({ code: 'invalid_targets' });
  });
});

describe('[R3] a kernel that dies mid-run still writes back the completed cells', () => {
  it('reports kernel_died with write_back.performed and the finished cell on disk', async () => {
    const nb = await writeNb('r3-kernel-died.ipynb', [
      codeCell('print("first")', 'c0'),
      codeCell('import sys\nprint("second")\nsys.stdout.flush()\nimport time\ntime.sleep(60)', 'c1'),
    ]);

    const running = runNotebook(request(nb, { cellSelector: 'all', timeoutSeconds: 120 }), deps());
    // Wait for cell 1 to be in flight, then kill the kernel the way an OOM
    // kill or an external taskkill would (no MCP call involved, so no run
    // layer had a chance to set an abort reason).
    let killed = false;
    for (let i = 0; i < 200; i += 1) {
      const live = registry.findByNotebook(nb);
      if (live !== null && live.executionCount !== null && live.executionCount >= 1) {
        const { execFileSync } = await import('node:child_process');
        const pid = live.pid ?? 0;
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGKILL');
        }
        killed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(killed).toBe(true);

    let caught: unknown;
    try {
      await running;
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(IpynbError);
    const err = caught as IpynbError;
    expect(err.code).toBe('kernel_died');
    const detail = err.detail as Record<string, unknown>;
    // SPEC §4.8 rule 3: completed cells are written back, and the terminal
    // state reports it.
    expect(detail['write_back']).toMatchObject({ performed: true });
    const executed = detail['executed'] as Array<Record<string, unknown>>;
    expect(executed.map((entry) => entry['cell_index'])).toEqual([0]);

    const cells = await readCells(nb);
    expect(cells[0]!['execution_count']).toBe(1);
    expect(JSON.stringify(cells[0]!['outputs'])).toContain('first');
    // The in-flight cell's half-finished output never lands (SPEC §4.8 rule 2).
    expect(cells[1]!['execution_count']).toBeNull();
    expect(cells[1]!['outputs']).toEqual([]);
  }, 180_000);
});

describe('[W3] a failed write-back never replaces the primary error code', () => {
  it('still reports exec_timeout when the notebook changed under the run', async () => {
    const nb = await writeNb('w3-timeout.ipynb', [
      codeCell('print("done")', 'c0'),
      // Ignores SIGINT so the run ends in the timeout path (not a cancel).
      codeCell(
        'import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nimport time\nwhile True: time.sleep(0.1)',
        'c1',
      ),
    ]);

    // Change the file while the run is executing: the write-back's optimistic
    // lock then fails with file_changed, which used to be thrown INSTEAD of
    // exec_timeout, hiding the real outcome from the model.
    const clobber = setTimeout(() => {
      const cells = [
        { cell_type: 'code', id: 'c0', metadata: {}, source: 'print("done")', outputs: [], execution_count: null },
        {
          cell_type: 'code',
          id: 'c1',
          metadata: {},
          source: 'import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nimport time\nwhile True: time.sleep(0.1)',
          outputs: [],
          execution_count: null,
        },
      ];
      void import('node:fs/promises').then((fs) =>
        fs.writeFile(
          nb,
          JSON.stringify({
            nbformat: 4,
            nbformat_minor: 5,
            metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' }, touched: 'yes' },
            cells,
          }),
        ),
      );
    }, 2_500);

    let caught: unknown;
    try {
      await runNotebook(request(nb, { cellSelector: 'all', timeoutSeconds: 3 }), deps());
    } catch (cause) {
      caught = cause;
    } finally {
      clearTimeout(clobber);
    }
    expect(caught).toBeInstanceOf(IpynbError);
    const err = caught as IpynbError;
    expect(err.code).toBe('exec_timeout');
    const writeBack = (err.detail as Record<string, unknown>)['write_back'] as Record<string, unknown>;
    // The failure is reported, not hidden ...
    expect(writeBack['performed']).toBe(false);
    // ... and says why.
    expect(String(writeBack['reason'])).toContain('file_changed');
  }, 120_000);
});

describe('[ROB-8] a cancel that lands AFTER the last cell still reports what it did', () => {
  it('cancelled carries write_back and the completed cell is on disk', async () => {
    // The window: every cell finished, the write-back has not started yet. The
    // old code threw a bare `cancelled` with an EMPTY detail, so the finished
    // cell was neither written nor reported — while the same terminal code
    // reached through the mid-cell path DID report it (review v3 ROB-8).
    const nb = await writeNb('rob8-cancel-window.ipynb', [codeCell('print("finished")', 'c0')]);

    const controller = new AbortController();
    let caught: unknown;
    try {
      await runNotebook(
        request(nb, {
          cellSelector: 'all',
          abort: { signal: controller.signal, reason: 'cancelled' },
        }),
        {
          ...deps(),
          // The write_back progress event is emitted immediately before the
          // real write starts, so aborting here lands in the window
          // deterministically instead of racing it.
          onProgress: (event) => {
            if (event.phase === 'write_back') {
              controller.abort();
            }
          },
        },
      );
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(IpynbError);
    const err = caught as IpynbError;
    expect(err.code).toBe('cancelled');
    const detail = err.detail as Record<string, unknown>;
    // The terminal state must report the work that finished (SPEC §4.8 rule 3).
    expect(detail['executed_cells']).toBe(1);
    expect((detail['executed'] as unknown[]).length).toBe(1);
    // The signal-aborted write is discarded, then the failure-path write-back
    // (which deliberately ignores the abort signal) commits the result.
    expect(detail['write_back']).toMatchObject({ performed: true });
    const cells = await readCells(nb);
    expect(cells[0]!['execution_count']).toBe(1);
  }, 120_000);
});

describe('[FID-1] the file the run writes is valid nbformat', () => {
  it('passes the real nbformat validator, and the tool can read its own outputs back', async (context) => {
    // Skips (visibly, with the reason in the test name) when nbformat is absent,
    // and FAILS when the environment requires it: an external authority that is
    // merely optional degrades to "nothing was checked" on a bare machine, which
    // is exactly what happened in CI (review v7 P0-a).
    const skip = nbformatSkipReason(authorityInterpreter());
    if (skip !== null) {
      context.skip(skip);
      return;
    }
    // The bug this pins: `result.result.rawOutputs` (the sidecar's private
    // shape: `outputType`, camelCase) was assigned straight to `cell.outputs`.
    // Every executed cell produced a file nbformat rejects, the outputs could
    // not be read back, and the run still reported `write_back.performed: true`
    // with no warning — three review rounds missed it because every assertion
    // spoke the same dialect the writer spoke. An external validator does not
    // (review v4 FID-1).
    const nb = await writeNb('fid1-valid.ipynb', [
      codeCell('print("stream-output")\n7 * 6', 'c0'),
    ]);

    const outcome = await runNotebook(request(nb, { cellSelector: 'all' }), deps());
    expect(outcome.write_back.performed).toBe(true);
    const executed = outcome.executed[0]!;
    expect(executed.status).toBe('ok');
    // The run must actually have produced outputs, otherwise this case would
    // pass vacuously on a writer that emits nothing.
    expect(executed.outputs.length).toBeGreaterThanOrEqual(2);

    const onDisk = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    const outputs = onDisk.cells[0]!['outputs'] as Array<Record<string, unknown>>;
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    for (const output of outputs) {
      expect(output['output_type'], 'the private protocol key leaked into the file').toBeDefined();
      expect(output['outputType']).toBeUndefined();
    }
    // nbformat requires execution_count ON execute_result specifically: a bare
    // `outputType` -> `output_type` rename would still fail here.
    const executeResult = outputs.find((output) => output['output_type'] === 'execute_result');
    expect(executeResult, 'print + expression should yield an execute_result').toBeDefined();
    expect('execution_count' in executeResult!).toBe(true);

    {
      const validation = validateNotebook(nb, authorityInterpreter());
      expect(validation.ok, `nbformat.validate rejected the written file:\n${validation.message}`).toBe(true);
    }

    // Round-trip: the tool must be able to read what it wrote. Before the fix
    // it reported "no outputs" for a cell it had just filled.
    const readBack = await runNotebook(request(nb, { cellSelector: 'all', mode: 'resume' }), deps());
    expect(readBack.executed[0]!.outputs.length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it('[FID-3] code -> markdown leaves a document the validator accepts', async (context) => {
    const skip = nbformatSkipReason(authorityInterpreter());
    if (skip !== null) {
      context.skip(skip);
      return;
    }
    const nb = await writeNb('fid3-markdown.ipynb', [
      codeCell('print("before")', 'c0'),
    ]);
    await runNotebook(request(nb, { cellSelector: 'all' }), deps());

    // Convert the executed cell to markdown through the real tool path.
    const edit = await handleNotebookEdit(depsContext(), {
      path: nb,
      ops: [{ op: 'set_cell_type', cell_index: 0, cell_type: 'markdown', expected_text: 'print("before")' }],
    });
    expect('error' in edit).toBe(false);

    const onDisk = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    expect('execution_count' in onDisk.cells[0]!).toBe(false);
    expect('outputs' in onDisk.cells[0]!).toBe(false);

    {
      const validation = validateNotebook(nb, authorityInterpreter());
      expect(validation.ok, `nbformat.validate rejected the converted file:\n${validation.message}`).toBe(true);
    }
  }, 120_000);
});
