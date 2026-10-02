// Review D2: the symtable analyzer itself must be covered in the DEFAULT
// test loop — the U18/U19b integration cases exist but `pnpm test` never
// ran them, so swapping symtable back for naive AST walking (or regex)
// kept everything green. This suite talks to the REAL sidecar analyze op
// and skips (with a recorded reason) when no Python is available, keeping
// the "no Python required" guarantee for unit tests.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/log.js';
import { SidecarTransport } from '../../src/kernel/sidecar-transport.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENV_DIR = path.join(REPO_ROOT, 'tests', '.venv-test');
const WINDOWS = process.platform === 'win32';
const VENV_PY = WINDOWS ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python');
const BASE_PYTHON = process.env['IPYNB_TEST_PYTHON'] ?? (WINDOWS ? 'python' : 'python3');

const PYTHON_AVAILABLE =
  existsSync(VENV_PY) ||
  spawnSync(WINDOWS ? 'python' : 'python3', ['-c', ''], { timeout: 5000 }).status === 0;

function interpreter(): string {
  if (existsSync(VENV_PY)) {
    return VENV_PY;
  }
  return BASE_PYTHON;
}

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
  it.skipIf(!PYTHON_AVAILABLE)('stale_analysis.method is "skipped" and stale_cells stays empty', async () => {
    const { execFileSync } = await import('node:child_process');
    if (!existsSync(VENV_PY)) {
      execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', VENV_DIR], { stdio: 'ignore', timeout: 120_000 });
    }
    const { KernelRegistry } = await import('../../src/kernel/registry.js');
    const { runNotebook } = await import('../../src/run.js');
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
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
      JSON.stringify({ argv: [VENV_PY, '-m', 'ipykernel', '-f', '{connection_file}'], display_name: 'Fake R', language: 'r' }),
    );
    process.env['JUPYTER_PATH'] = kernelsRoot;
    const nb = path.join(workspace, 'u20.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'fake-r' }, language_info: { name: 'r' } },
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
