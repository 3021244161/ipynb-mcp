// I15: a file held open with a NON-SHARED handle (Windows) maps to
// notebook_locked, never internal. On other platforms the scenario is skipped and
// recorded (SPEC §10.2).
//
// This case has now failed twice in ways that had nothing to do with the product,
// and both times the reason was the same: the test could not tell whether its own
// precondition was in place.
//   1. The first version took its "unchanged" snapshot with `readFile` AFTER the
//      exclusive holder was running, so the snapshot itself threw EBUSY (CI issue
//      #1 problem 3).
//   2. The second version slept a fixed 1.5 s hoping the holder had taken the
//      handle, and never checked. On windows-latest it had not, so the WRITE-phase
//      case ran against an UNLOCKED file, the edit succeeded, and the failure
//      surfaced as `expected [EBUSY, EPERM, EACCES] to include 'undefined'` —
//      pointing at the product while the test's own setup was the problem.
//      (A local reproduction showed the same thing: with the lock never taken,
//      both cases pass.)
// So every phase now WAITS FOR THE HOLDER TO REPORT that the handle is open, and
// the holder verifies the handle itself (`CreateFileW` returning INVALID_HANDLE_VALUE
// used to be a silent `sys.exit(1)` that nobody looked at). The verification read
// happens after the handle is closed: an exclusive handle refuses the check too.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { PathFence } from '../../src/fs/fence.js';
import { createLogger } from '../../src/log.js';
import { handleNotebookEdit } from '../../src/mcp/tools/edit.js';
import { toCallToolResult } from '../../src/mcp/tools/result.js';
import { BASE_PYTHON, VENV_DIR, VENV_PY } from './test-venv.js';

const WINDOWS = process.platform === 'win32';

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

const PYTHON_HOLDER = `
import ctypes, json, os, sys, time
from ctypes import wintypes

CreateFileW = ctypes.windll.kernel32.CreateFileW
CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                        ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
CreateFileW.restype = wintypes.HANDLE
GENERIC_READ = 0x80000000
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
FILE_ATTRIBUTE_NORMAL = 0x80

path, seconds = sys.argv[1], float(sys.argv[2])
trigger = sys.argv[3] if len(sys.argv) > 3 else ''
release = sys.argv[4] if len(sys.argv) > 4 else ''

if trigger:
    deadline = time.time() + 30
    while not os.path.exists(trigger):
        if time.time() > deadline:
            print(json.dumps({"ok": False, "why": "trigger never appeared"}), flush=True)
            sys.exit(2)
        time.sleep(0.01)

# The argtypes above are load-bearing: without them the 64-bit path pointer is
# truncated and CreateFileW fails with ERROR_INVALID_NAME, which the old version
# reported only as a silent sys.exit(1).
handle = CreateFileW(path, GENERIC_READ, 0, None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None)
if handle == INVALID_HANDLE_VALUE or handle is None:
    print(json.dumps({"ok": False, "why": "CreateFileW failed"}), flush=True)
    sys.exit(1)
try:
    print(json.dumps({"ok": True}), flush=True)
    if release:
        # Wait for the RELEASE file instead of a timeout, so the test decides when
        # the handle closes. Killing the child does not do it: SIGTERM does not
        # interrupt Python's sleep on Windows, so the handle stayed open and the
        # verification read failed with EBUSY — a test failure that looked like a
        # product failure (the same confusion as the two earlier versions of this
        # case).
        deadline = time.time() + 30
        while not os.path.exists(release):
            if time.time() > deadline:
                sys.exit(3)
            time.sleep(0.01)
    else:
        time.sleep(seconds)
finally:
    ctypes.windll.kernel32.CloseHandle(handle)
    print(json.dumps({"released": True}), flush=True)
`;

interface Holder {
  readonly child: ReturnType<typeof spawn>;
  readonly exited: Promise<number | null>;
  /** Path whose appearance tells the holder to close the handle. */
  readonly release: string;
}

/**
 * Starts the exclusive handle and resolves only once it reports that it is HELD.
 *
 * Waiting for the report is the whole point: an earlier version slept and hoped, so
 * a holder that failed to take the handle left the case passing against an unlocked
 * file.
 */
async function startHolder(target: string, seconds: number, trigger?: string): Promise<Holder> {
  const release = path.join(workspace, `release-${path.basename(target)}`);
  const args = ['-c', PYTHON_HOLDER, target, String(seconds)];
  if (trigger !== undefined) {
    args.push(trigger);
  } else {
    args.push('');
  }
  args.push(release);
  const child = spawn(VENV_PY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const held = await new Promise<boolean>((resolve) => {
    const deadline = Date.now() + 30_000;
    const poll = setInterval(() => {
      if (stdout.includes('"ok": true')) {
        clearInterval(poll);
        resolve(true);
      } else if (stdout.includes('"ok": false') || Date.now() > deadline) {
        clearInterval(poll);
        resolve(false);
      }
    }, 25);
  });
  if (!held) {
    child.kill();
    await exited;
    throw new Error(`the exclusive holder never took the lock: ${stdout.trim()} ${stderr.trim()}`);
  }
  return { child, exited, release };
}

/**
 * Closes the holder's handle and waits for the process to be gone.
 *
 * `child.kill()` alone is not enough: on Windows SIGTERM does not interrupt
 * Python's `time.sleep`, so the handle stayed open and the verification read threw
 * EBUSY — a test failure wearing the costume of a product failure.
 */
async function stopHolder(holder: Holder): Promise<void> {
  writeFileSync(holder.release, 'release');
  const gone = await Promise.race([
    holder.exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
  ]);
  if (gone === 'timeout') {
    holder.child.kill();
    await holder.exited;
  }
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
  // lock apart from a permission problem (CI issue #1 problem 3). NOTE: any code
  // path that reaches the lock must carry it — the backup copy is one of them, and
  // it used to build this error inline without the errno.
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
    const beforeStat = await stat(nb);
    const holder = await startHolder(nb, 20);
    try {
      const outcome = await handleNotebookEdit(toolContext(), {
        path: nb,
        ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
      });
      expectLocked(outcome);
    } finally {
      await stopHolder(holder);
    }
    // "The file did not change" can only be CHECKED once the lock is gone.
    // Comparing mtime as well means a write that happened to preserve the bytes
    // would still be visible.
    expect(await readFile(nb)).toEqual(before);
    expect((await stat(nb)).mtimeMs).toBe(beforeStat.mtimeMs);
  }, 120_000);

  it('WRITE phase: the lock appears after the read succeeded', async (context) => {
    if (!WINDOWS) {
      context.skip('Windows-only scenario (exclusive file handles)');
      return;
    }
    const nb = await writeNotebook('locked-write.ipynb');
    const before = await readFile(nb);
    const trigger = path.join(workspace, 'take-the-lock');
    let holder: Holder | null = null;
    try {
      const outcome = await handleNotebookEdit(
        toolContext(),
        {
          path: nb,
          ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 2' }],
        },
        {
          // Fires after the read/hash check and before the write lands, so the lock
          // is guaranteed to appear only once "the read succeeded" is settled.
          // Without this the case could pass because the READ hit the lock, which
          // is the other case's job.
          //
          // It AWAITS the holder's report, which is what makes the lock real
          // rather than hoped for: the previous version wrote the trigger file and
          // returned, leaving the write to race the holder's process startup — and
          // on windows-latest the write won, so the case reported
          // `expected [EBUSY, EPERM, EACCES] to include 'undefined'` against an
          // unlocked file.
          beforeWrite: async () => {
            writeFileSync(trigger, 'now');
            holder = await startHolder(nb, 20, trigger);
          },
        },
      );
      expectLocked(outcome);
    } finally {
      if (holder !== null) {
        await stopHolder(holder);
      }
    }
    // Same rule as the READ phase: verify only after the handle is closed.
    expect(await readFile(nb)).toEqual(before);

    // The same edit succeeds once the lock is gone: the failure was the lock, not
    // a stuck write path.
    const recovered = await handleNotebookEdit(toolContext(), {
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_text: 'x = 1', new_text: 'x = 3' }],
    });
    expect(toCallToolResult(recovered).isError).toBeUndefined();
  }, 120_000);
});
