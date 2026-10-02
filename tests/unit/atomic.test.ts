import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { open as fsOpen } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IpynbError } from '../../src/core/errors.js';
import { atomicWriteFile, type AtomicWriteDeps, type FileHandleLike } from '../../src/fs/atomic.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-atomic-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tmpFiles(): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((name) => name.includes('.tmp-'));
}

function errorWithCode(code: string): Error & { code: string } {
  const err = new Error(`mock ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('[step2] atomicWriteFile', () => {
  it('writes the target content and leaves no temp files behind', async () => {
    const target = path.join(dir, 'nb.ipynb');
    await atomicWriteFile(target, '{"cells": []}');
    expect(await readFile(target, 'utf8')).toBe('{"cells": []}');
    expect(await tmpFiles()).toEqual([]);
  });

  it('overwrites an existing target', async () => {
    const target = path.join(dir, 'nb2.ipynb');
    await writeFile(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('maps EBUSY/EPERM/EACCES on rename to notebook_locked (D12)', async () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const deps: AtomicWriteDeps = {
        open: (target, flags, mode) => fsOpen(target, flags, mode) as Promise<FileHandleLike>,
        rename: async () => {
          throw errorWithCode(code);
        },
        unlink: (t) => import('node:fs/promises').then((m) => m.unlink(t)),
        fsyncDir: async () => undefined,
        stat: async () => null,
      readdir: async () => [],
      now: () => new Date(),
      };
      const target = path.join(dir, `locked-${code}.ipynb`);
      await expect(atomicWriteFile(target, 'x', { deps })).rejects.toMatchObject({
        code: 'notebook_locked',
      });
      expect((await tmpFiles()).filter((f) => f.startsWith(`.locked-${code}`))).toEqual([]);
    }
  });

  it('discards the temp file and leaves the target unchanged when aborted before rename', async () => {
    const target = path.join(dir, 'abort-mid.ipynb');
    await writeFile(target, 'original');
    const controller = new AbortController();
    // Abort right after the handle is closed, before the rename step.
    const deps: AtomicWriteDeps = {
      open: (target, flags, mode) => fsOpen(target, flags, mode) as Promise<FileHandleLike>,
      rename: async () => undefined,
      unlink: (t) => import('node:fs/promises').then((m) => m.unlink(t)),
      fsyncDir: async () => undefined,
      stat: async () => null,
      readdir: async () => [],
      now: () => new Date(),
    };
    const wrappingDeps: AtomicWriteDeps = {
      ...deps,
      open: async (t, f, m) => {
        const handle = await deps.open(t, f, m);
        const original = handle.close.bind(handle);
        handle.close = async () => {
          await original();
          controller.abort(new Error('aborted by test'));
        };
        return handle;
      },
    };
    await expect(
      atomicWriteFile(target, 'should-not-land', { deps: wrappingDeps, signal: controller.signal }),
    ).rejects.toThrow('aborted by test');
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await tmpFiles()).toEqual([]);
  });

  it('cleans the temp file up when rename fails', async () => {
    const target = path.join(dir, 'failed-rename.ipynb');
    const deps: AtomicWriteDeps = {
      open: (target, flags, mode) => fsOpen(target, flags, mode) as Promise<FileHandleLike>,
      rename: async () => {
        throw errorWithCode('EPERM');
      },
      unlink: (t) => import('node:fs/promises').then((m) => m.unlink(t)),
      fsyncDir: async () => undefined,
      stat: async () => null,
      readdir: async () => [],
      now: () => new Date(),
    };
    await expect(atomicWriteFile(target, 'x', { deps })).rejects.toBeInstanceOf(IpynbError);
    expect(await tmpFiles()).toEqual([]);
  });

  it('the wx flag makes an existing temp name a hard error, never a clobber (SPEC D12)', async () => {
    // Real assertion of the open('wx') contract: an EEXIST from the exclusive
    // create must surface as an error and must NOT fall back to overwriting.
    const target = path.join(dir, 'wx.ipynb');
    let openedFlags = '';
    const deps: AtomicWriteDeps = {
      open: async (tmpTarget, flags) => {
        openedFlags = flags;
        void tmpTarget;
        throw errorWithCode('EEXIST');
      },
      rename: async () => undefined,
      unlink: async () => undefined,
      fsyncDir: async () => undefined,
      stat: async () => null,
      readdir: async () => [],
      now: () => new Date(),
    };
    await expect(atomicWriteFile(target, 'x', { deps })).rejects.toThrow();
    expect(openedFlags).toBe('wx');
  });

  it('skips directory fsync on win32 and performs it on linux (SPEC §9)', async () => {
    let fsyncCalls = 0;
    const deps: AtomicWriteDeps = {
      open: (target, flags, mode) => fsOpen(target, flags, mode) as Promise<FileHandleLike>,
      rename: (from, to) => import('node:fs/promises').then((m) => m.rename(from, to)),
      unlink: (t) => import('node:fs/promises').then((m) => m.unlink(t)),
      fsyncDir: async () => {
        fsyncCalls += 1;
      },
      stat: async () => null,
      readdir: async () => [],
      now: () => new Date(),
    };
    await atomicWriteFile(path.join(dir, 'win.ipynb'), 'x', { deps, platform: 'win32' });
    expect(fsyncCalls).toBe(0);
    await atomicWriteFile(path.join(dir, 'lin.ipynb'), 'x', { deps, platform: 'linux' });
    expect(fsyncCalls).toBe(1);
  });

  it('concurrent writes to the same target both succeed (uuid-unique temp names)', async () => {
    // Renamed from 'refuses to clobber ... (wx flag)' (review D5): the body
    // tests concurrency, not the wx flag. The flag itself is asserted by the
    // dedicated case below.
    const target = path.join(dir, 'concurrent.ipynb');
    await Promise.all([
      atomicWriteFile(target, 'a'),
      atomicWriteFile(target, 'b'),
    ]);
    const content = await readFile(target, 'utf8');
    expect(['a', 'b']).toContain(content);
    expect(await tmpFiles()).toEqual([]);
  });

  it('[W1] a TRANSIENT sharing violation on rename is retried, not reported as locked', async () => {
    // Windows reports the same EBUSY/EPERM/EACCES for "another process holds
    // this file" and for a momentary collision between two renames of one
    // target. Treating the second as the first handed the model
    // `notebook_locked` — the one error it is told to stop and ask the user
    // about — while nothing held a lock. This test failed intermittently in
    // practice before the retry existed.
    const target = path.join(dir, 'transient.ipynb');
    const realRename = (await import('node:fs/promises')).rename;
    let attempts = 0;
    const slept: number[] = [];
    const deps: AtomicWriteDeps = {
      open: (t, flags, mode) => fsOpen(t, flags, mode) as Promise<FileHandleLike>,
      rename: async (from, to) => {
        attempts += 1;
        if (attempts <= 3) {
          throw errorWithCode('EPERM');
        }
        await realRename(from, to);
      },
      unlink: (t) => import('node:fs/promises').then((m) => m.unlink(t)),
      fsyncDir: async () => undefined,
      stat: async () => null,
      readdir: async () => [],
      now: () => new Date(),
      // Injected so the retry window is exercised without real waiting (R11).
      sleep: async (ms) => {
        slept.push(ms);
      },
    };
    await atomicWriteFile(target, 'retried', { deps, platform: 'win32' });
    expect(await readFile(target, 'utf8')).toBe('retried');
    expect(attempts).toBe(4);
    expect(slept).toEqual([10, 20, 40]);
    expect(await tmpFiles()).toEqual([]);
  });

  it('[W1] a PERSISTENT lock still becomes notebook_locked (the retry is bounded)', async () => {
    const target = path.join(dir, 'persistent.ipynb');
    let attempts = 0;
    const deps: AtomicWriteDeps = {
      open: (t, flags, mode) => fsOpen(t, flags, mode) as Promise<FileHandleLike>,
      rename: async () => {
        attempts += 1;
        throw errorWithCode('EBUSY');
      },
      unlink: (t) => import('node:fs/promises').then((m) => m.unlink(t)),
      fsyncDir: async () => undefined,
      stat: async () => null,
      readdir: async () => [],
      now: () => new Date(),
      sleep: async () => undefined,
    };
    const failure = await atomicWriteFile(target, 'never', { deps, platform: 'win32' }).catch((c: unknown) => c);
    expect(failure).toBeInstanceOf(IpynbError);
    expect((failure as IpynbError).code).toBe('notebook_locked');
    // Bounded: the full delay schedule plus the failing attempt, no more.
    expect(attempts).toBe(9);
    expect(await tmpFiles()).toEqual([]);
  });
});
