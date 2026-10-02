// I15: writing to a file held open with a NON-SHARED handle (Windows) maps
// to notebook_locked, never internal. On other platforms the scenario is
// skipped and recorded (SPEC §10.2).

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { PathFence } from '../../src/fs/fence.js';
import { createLogger } from '../../src/log.js';
import { handleNotebookEdit } from '../../src/mcp/tools/edit.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENV_DIR = path.join(REPO_ROOT, 'tests', '.venv-test');
const WINDOWS = process.platform === 'win32';
const VENV_PY = WINDOWS ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python');
const BASE_PYTHON = process.env['IPYNB_TEST_PYTHON'] ?? (WINDOWS ? 'python' : 'python3');

let workspace: string;
let registry: KernelRegistry;

beforeAll(async () => {
  if (!existsSync(VENV_PY)) {
    const { execFileSync } = await import('node:child_process');
    execFileSync(BASE_PYTHON, ['-m', 'venv', '--system-site-packages', VENV_DIR], { stdio: 'inherit', timeout: 120_000 });
  }
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-lock-'));
  registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') });
}, 180_000);

afterAll(async () => {
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

/** Opens the file with dwShareMode = 0 (exclusive) and holds it for N seconds. */
const HOLDER_SCRIPT = `
import sys, time
import ctypes
path = sys.argv[1]
seconds = float(sys.argv[2])
handle = ctypes.windll.kernel32.CreateFileW(path, 0x80000000, 0, None, 3, 0x80, None)
if handle == -1 or handle == 0xFFFFFFFFFFFFFFFF:
    sys.exit(1)
time.sleep(seconds)
ctypes.windll.kernel32.CloseHandle(handle)
`;

describe('[I15] exclusive-open writes raise notebook_locked (Windows)', () => {
  it('maps the lock error instead of internal', async (context) => {
    if (!WINDOWS) {
      context.skip('Windows-only scenario (exclusive file handles)');
      return;
    }
    const nb = path.join(workspace, 'locked.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
    }));
    const before = await readFile(nb);

    const holder = spawn(VENV_PY, ['-c', HOLDER_SCRIPT, nb, '20'], { stdio: 'ignore' });
    // Wait until the handle is held.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    try {
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
        logLevel: 'error',
      };
      const sourceHash = `sha256:${hasher.sha256Hex('x = 1')}`;
      const outcome = await handleNotebookEdit(
        {
          config,
          fence: new PathFence(workspace, false, process.platform),
          registry,
          runStore: new RunStore(),
          hasher,
          logger: createLogger('error'),
          realpath: (target) => realpathSync(target),
          platform: process.platform,
        },
        {
          path: nb,
          ops: [{ op: 'replace_source', cell_index: 0, expected_source_hash: sourceHash, new_text: 'x = 2' }],
        },
      );
      const result = toCallToolResult(outcome);
      expect(result.isError).toBe(true);
      const body = JSON.parse(String((result.content[0] as { text?: string }).text ?? '{}')) as Record<string, unknown>;
      expect(body['code']).toBe('notebook_locked');
      // The notebook itself was never modified.
      expect(await readFile(nb)).toEqual(before);
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once('exit', resolve));
    }
  }, 120_000);
});
