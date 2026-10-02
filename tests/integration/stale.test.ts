// Integration tests (step 8): stale analysis over a real sidecar's symtable
// pass, wired through runNotebook.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { pythonPrefix } from '../../src/kernel/interpreter.js';
import { runNotebook, type RunDeps } from '../../src/run.js';
import { createLogger } from '../../src/log.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENV_DIR = path.join(REPO_ROOT, 'tests', '.venv-test');
const WINDOWS = process.platform === 'win32';
const VENV_PY = WINDOWS ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python');
const BASE_PYTHON = process.env['IPYNB_TEST_PYTHON'] ?? (WINDOWS ? 'python' : 'python3');

let workspace: string;
let registry: KernelRegistry;

beforeAll(async () => {
  if (!existsSync(VENV_PY)) {
    execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', VENV_DIR], {
      stdio: 'inherit',
      timeout: 120_000,
    });
  }
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-stale-'));
  registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('debug') });
  registry.start();
  const basePython = BASE_PYTHON === 'python' || BASE_PYTHON === 'python3' ? null : BASE_PYTHON;
  const jupyterRoot = basePython !== null ? path.join(pythonPrefix(basePython), 'share', 'jupyter') : null;
  if (jupyterRoot !== null && existsSync(path.join(jupyterRoot, 'kernels'))) {
    process.env['JUPYTER_PATH'] = jupyterRoot;
  }
}, 180_000);

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

function deps(): RunDeps {
  const config: IpynbConfig = {
    root: workspace,
    allowOutsideRoot: false,
    readOnly: false,
    images: 'auto',
    python: null,
    kernelIdleSeconds: 3600,
    execTimeoutSeconds: 300,
    backgroundThresholdSeconds: 30,
    backupKeep: 10,
    artifactDir: path.join(workspace, 'artifacts'),
    inlineTextChars: 20000,
    previewLines: 12,
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    logLevel: 'info',
  };
  return {
    registry,
    hasher,
    config,
    imagesPolicy: 'auto',
    realpath: (target) => realpathSync(target),
  };
}

function codeCell(source: string, id: string, outputs: unknown[] = []): Record<string, unknown> {
  return { cell_type: 'code', id, metadata: {}, source, outputs, execution_count: outputs.length > 0 ? 1 : null };
}

async function writeNb(name: string, cells: Array<Record<string, unknown>>): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells,
  }));
  return target;
}

describe('[U18] symtable catches tuple unpacking (regex cannot)', () => {
  it('flags cell 1 as stale with high confidence and method python-symtable', async () => {
    const nb = await writeNb('u18.ipynb', [
      codeCell('a, b = 1, 2', 'c0'),
      codeCell('print(a)', 'c1', [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }]),
    ]);
    const outcome = await runNotebook({
      path: nb,
      cellSelector: '0',
      mode: 'auto',
      timeoutSeconds: 120,
      writeOutputs: true,
      clearOutputsBefore: true,
      createBackup: true,
    }, deps());
    expect(outcome.stale_analysis).toEqual({ approximate: true, analysis_version: 1, method: 'python-symtable' });
    expect(outcome.stale_cells).toEqual([
      { cell_index: 1, cell_id: 'c1', reason: 'uses-variable-defined-in-0', confidence: 'high' },
    ]);
  });
});

describe('[U19b] no false positive for function-local variables', () => {
  it('cell 4 with a local tmp is NOT stale', async () => {
    const nb = await writeNb('u19b.ipynb', [
      codeCell('tmp = 99', 'c3'),
      codeCell('def g():\n    tmp = 2\n    return tmp', 'c4', [
        // nbformat requires execution_count on execute_result, and the
        // structural self-check now enforces it: this seed used to omit the
        // key, so every fixture like it described a file nbformat rejects
        // (found by the FID-1 validator, kept honest by the gate).
        { output_type: 'execute_result', data: { 'text/plain': ['<function g>'] }, metadata: {}, execution_count: 1 },
      ]),
    ]);
    const outcome = await runNotebook({
      path: nb,
      cellSelector: '0',
      mode: 'auto',
      timeoutSeconds: 120,
      writeOutputs: true,
      clearOutputsBefore: true,
      createBackup: true,
    }, deps());
    expect(outcome.stale_analysis!.method).toBe('python-symtable');
    expect(outcome.stale_cells).toEqual([]);
  });
});

describe('[U25] syntax errors degrade the whole analysis to regex', () => {
  it('reports method regex, a degraded warning and low confidences only', async () => {
    const nb = await writeNb('u25.ipynb', [
      codeCell('y = 5', 'c0'),
      codeCell('print(y)', 'c1', [{ output_type: 'stream', name: 'stdout', text: ['5\n'] }]),
      codeCell('def broken(:\n    pass', 'c2'),
    ]);
    const outcome = await runNotebook({
      path: nb,
      cellSelector: '0',
      mode: 'auto',
      timeoutSeconds: 120,
      writeOutputs: true,
      clearOutputsBefore: true,
      createBackup: true,
    }, deps());
    expect(outcome.stale_analysis!.method).toBe('regex');
    expect(outcome.warnings.map((warning) => warning.code)).toContain('stale_analysis_degraded');
    for (const cell of outcome.stale_cells) {
      expect(cell.confidence).toBe('low');
    }
    // Regex still sees `print(y)` as a use of y (defined by executed cell 0):
    // cell 1 stays stale, degraded to low confidence.
    expect(outcome.stale_cells).toEqual([
      { cell_index: 1, cell_id: 'c1', reason: 'uses-variable-defined-in-0', confidence: 'low' },
    ]);
  });
});

describe('[U19] replay dependencies surface as low confidence', () => {
  it('cold-start replay marks downstream cells depends-on-replayed-cell-<i>', async () => {
    const nb = await writeNb('u19.ipynb', [
      codeCell('df = 1', 'c0'),
      codeCell('mid = 2', 'c1'),
      codeCell('model = df + mid', 'c5', [
        { output_type: 'execute_result', data: { 'text/plain': ['3'] }, metadata: {}, execution_count: 1 },
      ]),
      codeCell('report = df', 'c7', [
        { output_type: 'execute_result', data: { 'text/plain': ['1'] }, metadata: {}, execution_count: 1 },
      ]),
    ]);
    const outcome = await runNotebook({
      path: nb,
      cellSelector: '2', // executes the cell with id c5 (index 2)
      mode: 'auto',
      timeoutSeconds: 120,
      writeOutputs: true,
      clearOutputsBefore: true,
      createBackup: true,
    }, deps());
    expect(outcome.mode_used).toBe('replay');
    expect(outcome.replayed_cell_indexes).toEqual([0, 1]);
    // cell 7 (index 3) uses df defined in replayed cell 0 -> low confidence.
    expect(outcome.stale_cells).toEqual([
      { cell_index: 3, cell_id: 'c7', reason: 'depends-on-replayed-cell-0', confidence: 'low' },
    ]);
  });
});
