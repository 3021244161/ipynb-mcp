// I15: a file held open with a NON-SHARED handle (Windows) maps to
// notebook_locked, never internal. On other platforms the scenario is skipped
// and recorded (SPEC §10.2).
//
// The first version had a phase error that CI exposed: it took its "unchanged"
// snapshot with `readFile` AFTER the exclusive holder was running, so the
// snapshot itself threw EBUSY and the test never reached its assertions
// (CI issue #1 problem 3). Three things are fixed here:
//   - the snapshot is taken while the file is still readable;
//   - the READ phase and the WRITE phase each get a case (the issue asked for
//     coverage of "the read collides", which the original never had);
//   - the write-phase case triggers the lock deterministically through the
//     serializer hook, so it cannot silently degrade into "the read failed
//     first" and pass for the wrong reason.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
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

/**
 * Opens the file with dwShareMode = 0 (exclusive).
 *
 * With a trigger path as argv[3] the holder waits for that file to appear before
 * taking the handle, which is how the write-phase case pins the moment the lock
 * starts. Without it the handle is taken immediately.
 */
const HOLDER_SCRIPT = `
import os, sys, time
import ctypes
path = sys.argv[1]
seconds = float(sys.argv[2])
trigger = sys.argv[3] if len(sys.argv) > 3 else ''
if trigger:
    deadline = time.time() + 30
    while not os.path.exists(trigger):
        if time.time() > deadline:
            sys.exit(2)
        time.sleep(0.01)
handle = ctypes.windll.kernel32.CreateFileW(path, 0x80000000, 0, None, 3, 0x80, None)
if handle == -1 or handle == 0xFFFFFFFFFFFFFFFF:
    sys.exit(1)
time.sleep(seconds)
ctypes.windll.kernel32.CloseHandle(handle)
`;

interface Holder {
  readonly child: ReturnType<typeof spawn>;
  readonly exited: Promise<number | null>;
}

function startHolder(target: string, seconds: number, trigger?: string): Holder {
  const args = ['-c', HOLDER_SCRIPT, target, String(seconds)];
  if (trigger !== undefined) {
    args.push(trigger);
  }
  const child = spawn(VENV_PY, args, { stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  return { child, exited };
}

async function stopHolder(holder: Holder): Promise<void> {
  holder.child.kill();
  await holder.exited;
}

function toolContext(): Parameters<typeof handleNotebookEdit>[0] {
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
  return {
    config,
    fence: new PathFence(workspace, false, process.platform),
    registry,
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target) => realpathSync(target),
    platform: process.platform,
  };
}

async function writeNotebook(name: string): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
  }));
  return target;
}

function expectLocked(outcome: Awaited<ReturnType<typeof handleNotebookEdit>>): Record<string, unknown> {
  const result = toCallToolResult(outcome);
  expect(result.isError).toBe(true);
  const body = JSON.parse(String((result.content[0] as { text?: string }).text ?? '{}')) as Record<string, unknown>;
  expect(body['code']).toBe('notebook_locked');
  // The original errno survives in the detail: without it the model cannot tell a
  // lock apart from a permission problem (CI issue #1 problem 3).
  const detail = (body['detail'] ?? {}) as Record<string, unknown>;
  expect(['EBUSY', 'EPERM', 'EACCES']).toContain(String(detail['errno']));
  return body;
}

describe('[I15] exclusive-open writes raise notebook_locked (Windows)', () => {
  it('READ phase: the handler read collides with the exclusive handle', async (context) => {
    if (!WINDOWS) {
      context.skip('Windows-only scenario (exclusive file handles)');
      return;
    }
    const nb = await writeNotebook('locked-read.ipynb');
    // Snapshot BEFORE the lock exists: reading it afterwards is what broke CI.
    const before = await readFile(nb);
    const holder = startHolder(nb, 20);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      const outcome = await handleNotebookEdit(toolContext(), {
        path: nb,
        ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
      });
      expectLocked(outcome);
      expect(await readFile(nb)).toEqual(before);
    } finally {
      await stopHolder(holder);
    }
  }, 120_000);

  it('WRITE phase: the lock appears after the read succeeded', async (context) => {
    if (!WINDOWS) {
      context.skip('Windows-only scenario (exclusive file handles)');
      return;
    }
    const nb = await writeNotebook('locked-write.ipynb');
    const before = await readFile(nb);
    const trigger = path.join(workspace, 'take-the-lock');
    const holder = startHolder(nb, 20, trigger);
    try {
      const outcome = await handleNotebookEdit(
        toolContext(),
        {
          path: nb,
          ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
        },
        {
          // Fires after the read/hash check and before the write lands, so the
          // lock is guaranteed to appear only once "the read succeeded" is
          // settled. Without this the case could pass because the READ hit the
          // lock, which is the other case's job.
          beforeWrite: () => {
            writeFileSync(trigger, 'now');
            // Let the holder acquire the handle before the rename runs.
            const until = Date.now() + 750;
            while (Date.now() < until) {
              /* spin: the holder polls for the trigger every 10 ms */
            }
          },
        },
      );
      expectLocked(outcome);
      expect(await readFile(nb)).toEqual(before);
    } finally {
      await stopHolder(holder);
    }

    // The same edit succeeds once the lock is gone: the failure was the lock, not
    // a stuck write path.
    const recovered = await handleNotebookEdit(toolContext(), {
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 3' }],
    });
    expect(toCallToolResult(recovered).isError).toBeUndefined();
  }, 120_000);
});
