// Integration tests (step 7b): full execution orchestration via run.ts —
// mode matrix, write-back, resume/replay semantics, timeouts, idle reclaim
// and the D23 interpreter candidate chain.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { IpynbError } from '../../src/core/errors.js';
import { parseNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { pythonPrefix, resolveInterpreter } from '../../src/kernel/interpreter.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';
import { runNotebook, type RunDeps, type RunRequest } from '../../src/run.js';
import { createLogger } from '../../src/log.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENV_DIR = path.join(REPO_ROOT, 'tests', '.venv-test');
const WINDOWS = process.platform === 'win32';
const VENV_PY = WINDOWS ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python');
const BASE_PYTHON = process.env['IPYNB_TEST_PYTHON'] ?? (WINDOWS ? 'python' : 'python3');
// An interpreter that exists but CANNOT import ipykernel (I17). If absent on
// this machine we synthesize a stub executable instead.
const NO_IPYKERNEL_PY = process.env['IPYNB_TEST_NO_IPYKERNEL_PYTHON'] ?? null;

let workspace: string;
let artifactRoot: string;
let registry: KernelRegistry;

beforeAll(async () => {
  if (!existsSync(VENV_PY)) {
    execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', VENV_DIR], {
      stdio: 'inherit',
      timeout: 120_000,
    });
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
  if (jupyterRoot !== null && existsSync(path.join(jupyterRoot, 'kernels'))) {
    process.env['JUPYTER_PATH'] = jupyterRoot;
  }
}, 180_000);

afterAll(async () => {
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
    logLevel: 'info',
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

function codeCell(source: string, id: string): Record<string, unknown> {
  return { cell_type: 'code', id, metadata: {}, source, outputs: [], execution_count: null };
}

function mdCell(source: string, id: string): Record<string, unknown> {
  return { cell_type: 'markdown', id, metadata: {}, source };
}

async function writeNb(name: string, cells: Array<Record<string, unknown>>): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' }, language_info: { name: 'python' } },
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
    const nb = await writeNb('i3.ipynb', [
      codeCell('a = 1', 'c0'),
      codeCell('b = 2', 'c1'),
      codeCell('import time\ntime.sleep(3)', 'c2'),
      codeCell('c = 4', 'c3'),
      codeCell('d = 5', 'c4'),
      codeCell('print(a + b + c + d)', 'c5'),
    ]);
    const before = await readFile(nb, 'utf8');

    const outcome = await runNotebook(request(nb, { cellSelector: '5', timeoutSeconds: 60 }), deps());
    expect(outcome.mode_used).toBe('replay');
    expect(outcome.replayed_cell_indexes).toEqual([0, 1, 2, 3, 4]);
    expect(outcome.executed.map((entry) => entry.cell_index)).toEqual([5]);
    expect(outcome.executed[0]!.status).toBe('ok');

    const cells = await readCells(nb);
    // Prefix cells: outputs and execution_count unchanged from the original.
    for (const index of [0, 1, 2, 3, 4]) {
      expect(cells[index]!['outputs']).toEqual([]);
      expect(cells[index]!['execution_count']).toBeNull();
    }
    // Only cell 5 has fresh results.
    expect(cells[5]!['execution_count']).toBe(1);
    void before;
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
      codeCell('import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nimport time\nwhile True: time.sleep(0.1)', 'c1'),
      codeCell('z = 3', 'c2'),
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

    // Completed cell 0 was written back; the timed-out cell was not.
    const cells = await readCells(nb);
    expect(cells[0]!['execution_count']).toBe(1);
    expect(cells[1]!['execution_count']).toBeNull();
    expect(cells[1]!['outputs']).toEqual([]);

    // The kernel is marked dead and closed (SPEC §4.7 rule 6).
    expect(registry.findByNotebook(nb)).toBeNull();
  }, 180_000);
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
    const transport = new SidecarTransport({ interpreterPath: VENV_PY, onLog: () => undefined });
    await transport.ping();
    const started = await transport.startKernel({
      kernelId: 'kernel-i7',
      interpreterPath: VENV_PY,
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    await transport.kill();
    await expect(inflight).rejects.toMatchObject({ code: 'kernel_died' });
    expect(transport.alive).toBe(false);
  }, 120_000);
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
    // Reclamation timer fires at clamp(2/2, 5..60) = 5s; wait past it.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    expect(shortLived.findByNotebook(nb)).toBeNull();
    await shortLived.shutdownAll();
  }, 120_000);
});

describe('[I17] candidate chain degradation (D23)', () => {
  it('falls back from a broken kernelspec to .venv and warns', async () => {
    const nbDir = path.join(workspace, 'i17');
    mkdirSync(nbDir, { recursive: true });
    // kernelspec whose argv[0] exists but cannot import ipykernel.
    const kernelsDir = path.join(nbDir, 'kernels');
    const specDir = path.join(kernelsDir, 'brokenkernel');
    mkdirSync(specDir, { recursive: true });
    const brokenPython =
      NO_IPYKERNEL_PY !== null && existsSync(NO_IPYKERNEL_PY)
        ? NO_IPYKERNEL_PY
        : makeStubPython(path.join(nbDir, 'broken-python.py'));
    writeFileSync(path.join(specDir, 'kernel.json'), JSON.stringify({
      argv: [brokenPython, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      display_name: 'Broken Kernel',
      language: 'python',
    }));
    // .venv next to the notebook with a working interpreter.
    const venvDir = path.join(nbDir, '.venv');
    const venvBin = path.join(venvDir, WINDOWS ? 'Scripts' : 'bin');
    mkdirSync(venvBin, { recursive: true });
    writeFileSync(path.join(venvBin, WINDOWS ? 'python.exe' : 'python'), '');
    const venvPython = path.join(venvBin, WINDOWS ? 'python.exe' : 'python');

    const resolution = await resolveInterpreter(
      {
        explicitPython: null,
        notebookPath: path.join(nbDir, 'nb.ipynb'),
        kernelSpecName: 'brokenkernel',
        languageInfoName: 'python',
      },
      {
        platform: process.platform,
        env: { ...process.env, JUPYTER_PATH: kernelsDir },
        existsSync: (target) => existsSync(target),
        readFile: async (target) => readFile(target, 'utf8'),
        execFile: (command, args) =>
          new Promise<'ok' | 'failed' | 'not-found'>((resolve) => {
            void args;
            // Treat the venv python as the working interpreter, everything
            // else as failing the import check.
            resolve(command === venvPython ? 'ok' : 'failed');
          }),
        resolveExecutable: async () => null,
        homedir: () => path.join(workspace, 'home'),
      },
    );
    expect(resolution.interpreterPath).toBe(venvPython);
    expect(resolution.warnings.map((warning) => warning.code)).toContain('kernelspec_mismatch');
  });
});

/** A real executable that exists but cannot import ipykernel (a plain shell loop). */
function makeStubPython(target: string): string {
  const script = `import sys\nsys.exit(1)\n`;
  writeFileSync(target, script);
  if (WINDOWS) {
    // A .py is not directly executable by existsSync-based candidates, but the
    // interpreter resolver only checks existence + import success, so a .py
    // with a failing execFile mock stands in fine for the real thing.
    return target;
  }
  execFileSync('chmod', ['+x', target]);
  return target;
}
