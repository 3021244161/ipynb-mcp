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
    };
    await expect(atomicWriteFile(target, 'x', { deps })).rejects.toBeInstanceOf(IpynbError);
    expect(await tmpFiles()).toEqual([]);
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
    };
    await atomicWriteFile(path.join(dir, 'win.ipynb'), 'x', { deps, platform: 'win32' });
    expect(fsyncCalls).toBe(0);
    await atomicWriteFile(path.join(dir, 'lin.ipynb'), 'x', { deps, platform: 'linux' });
    expect(fsyncCalls).toBe(1);
  });

  it('refuses to clobber an existing temp file name (wx flag)', async () => {
    // Indirect: two concurrent writes to the same target must both succeed
    // because tmp names are uuid-unique.
    const target = path.join(dir, 'concurrent.ipynb');
    await Promise.all([
      atomicWriteFile(target, 'a'),
      atomicWriteFile(target, 'b'),
    ]);
    const content = await readFile(target, 'utf8');
    expect(['a', 'b']).toContain(content);
    expect(await tmpFiles()).toEqual([]);
  });
});
