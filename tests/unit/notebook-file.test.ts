// Notebook file read/write orchestration (review v2 W1/W7). SPEC anchors:
// §10.2 I15 (a locked notebook must map to notebook_locked, never internal),
// §4.1.8 (the optimistic-lock recheck), §5.5.5 (self check before writing).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IpynbError } from '../../src/core/errors.js';
import { parseNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import {
  pendingWriteLockCount,
  readNotebookFile,
  translateLockError,
  writeNotebookFile,
} from '../../src/fs/notebook-file.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-nbfile-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOTEBOOK_JSON = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
});

function errorWithCode(code: string): Error & { code: string } {
  const err = new Error(`mock ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('[W1] lock errors map to notebook_locked on the READ path too', () => {
  it('translates EBUSY/EPERM/EACCES but leaves ENOENT and other errnos alone', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const mapped = translateLockError(errorWithCode(code), 'C:/work/nb.ipynb');
      expect(mapped).toBeInstanceOf(IpynbError);
      expect((mapped as IpynbError).code).toBe('notebook_locked');
      // The raw errno travels with the code so the caller can tell a sharing
      // violation from a permission problem (CI issue #1 problem 3).
      expect((mapped as IpynbError).detail).toEqual({ path: 'C:/work/nb.ipynb', errno: code });
    }
    // ENOENT has its own code (file_not_found) and is handled by the caller;
    // anything else must stay untouched so it is not mislabelled.
    const enoent = errorWithCode('ENOENT');
    expect(translateLockError(enoent, 'C:/work/nb.ipynb')).toBe(enoent);
    const eisdir = errorWithCode('EISDIR');
    expect(translateLockError(eisdir, 'C:/work/nb.ipynb')).toBe(eisdir);
  });

  it('readNotebookFile still reads a normal file and reports ENOENT as file_not_found', async () => {
    const target = path.join(dir, 'read.ipynb');
    await writeFile(target, NOTEBOOK_JSON);
    const notebook = await readNotebookFile(target, hasher);
    expect(notebook.cells).toHaveLength(1);

    await expect(readNotebookFile(path.join(dir, 'missing.ipynb'), hasher)).rejects.toMatchObject({
      code: 'file_not_found',
    });
  });

  it('[TST-7] the READ PATH itself maps a lock errno (wiring, not just the helper)', async () => {
    // Mutation-proven gap: asserting translateLockError() alone stayed green
    // when the read path was reverted to `throw cause` — it guarded the
    // helper's semantics but not its use (review v3 TST-7). This drives
    // readNotebookFile with a reader that fails the way a held-open file does.
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      await expect(
        readNotebookFile(path.join(dir, 'locked.ipynb'), hasher, {
          readFileImpl: () => Promise.reject(errorWithCode(code)),
        }),
      ).rejects.toMatchObject({ code: 'notebook_locked' });
    }
    await expect(
      readNotebookFile(path.join(dir, 'gone.ipynb'), hasher, {
        readFileImpl: () => Promise.reject(errorWithCode('ENOENT')),
      }),
    ).rejects.toMatchObject({ code: 'file_not_found' });
  });

  it('[W1b] the BACKUP COPY path maps a lock errno and keeps it in the detail', async () => {
    // The third syscall that can meet the lock, and the one CI's windows-latest
    // job actually hit: the backup copy runs BEFORE the rename, so a held-open
    // notebook fails there first. That branch built its error inline and dropped
    // `errno`, so the WRITE-phase integration case reported
    // `expected [EBUSY, EPERM, EACCES] to include 'undefined'` while the READ
    // phase reported 'EBUSY' for the same lock. Asserting the detail (not just
    // the code) is what makes the two paths agree.
    const target = path.join(dir, 'backup-locked.ipynb');
    await writeFile(target, NOTEBOOK_JSON);
    const notebook = await readNotebookFile(target, hasher);
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      // The errno is the assertion this case exists for. The path is compared by
      // FILENAME, not as a string: macOS reports `/private/var/...` where the test
      // created `/var/...` (the runner failed exactly there) and Windows has 8.3
      // short names, so an exact match tests the platform's symlink reporting
      // rather than the product.
      const failure = await writeNotebookFile(notebook, target, {
        hasher,
        backupKeep: 10,
        createBackup: true,
        expectedContentHash: notebook.contentHash,
        platform: 'win32',
        copyFileImpl: () => Promise.reject(errorWithCode(code)),
      }).then(
        () => null,
        (cause: unknown) => cause as IpynbError,
      );
      expect(failure?.code).toBe('notebook_locked');
      const detail = failure?.detail as Record<string, unknown>;
      expect(detail['errno']).toBe(code);
      expect(path.basename(String(detail['path']))).toBe(path.basename(target));
    }
    // …and a non-lock failure is not relabelled as a lock.
    await expect(
      writeNotebookFile(notebook, target, {
        hasher,
        backupKeep: 10,
        createBackup: true,
        expectedContentHash: notebook.contentHash,
        platform: 'win32',
        copyFileImpl: () => Promise.reject(errorWithCode('ENOSPC')),
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
  });
});

describe('[W7] the per-path write lock is released and does not accumulate', () => {
  it('leaves no settled promise behind for the same path', async () => {
    const target = path.join(dir, 'lock.ipynb');
    await writeFile(target, NOTEBOOK_JSON);
    expect(pendingWriteLockCount()).toBe(0);

    for (let i = 0; i < 3; i += 1) {
      // Re-read each round: the on-disk bytes are the anchor for the recheck.
      const notebook = await readNotebookFile(target, hasher);
      await writeNotebookFile(notebook, target, {
        hasher,
        backupKeep: 10,
        createBackup: false,
        expectedContentHash: notebook.contentHash,
        platform: 'win32',
      });
      // The old cleanup compared against a freshly built promise, so it never
      // matched and every path kept an entry forever (review W7).
      expect(pendingWriteLockCount()).toBe(0);
    }

    // A second spelling of the same file locks the same key on a
    // case-insensitive platform, so it must not create a second entry either.
    if (process.platform === 'win32') {
      const upper = target.replace(/lock\.ipynb$/, 'LOCK.ipynb');
      const notebook = await readNotebookFile(target, hasher);
      await writeNotebookFile(notebook, upper, {
        hasher,
        backupKeep: 10,
        createBackup: false,
        expectedContentHash: notebook.contentHash,
        platform: 'win32',
      });
      expect(pendingWriteLockCount()).toBe(0);
    }
    expect(await readFile(target, 'utf8')).toContain('x = 1');
  });

  it('releases the lock even when the write fails', async () => {
    const target = path.join(dir, 'failing.ipynb');
    await writeFile(target, NOTEBOOK_JSON);
    const notebook = await readNotebookFile(target, hasher);
    await expect(
      writeNotebookFile(notebook, target, {
        hasher,
        backupKeep: 10,
        createBackup: false,
        expectedContentHash: 'sha256:not-what-is-on-disk',
        platform: 'win32',
      }),
    ).rejects.toMatchObject({ code: 'file_changed' });
    expect(pendingWriteLockCount()).toBe(0);
  });

  it('serialises concurrent writes to the same path instead of losing one', async () => {
    const target = path.join(dir, 'concurrent.ipynb');
    await writeFile(target, NOTEBOOK_JSON);
    const first = parseNotebook(new TextEncoder().encode(NOTEBOOK_JSON), hasher);
    const second = parseNotebook(new TextEncoder().encode(NOTEBOOK_JSON), hasher);
    second.cells[0]!.source = 'x = 2';

    // Both start from the same expected hash: with the lock in place the loser
    // must observe file_changed rather than silently overwriting the winner.
    const results = await Promise.allSettled([
      writeNotebookFile(first, target, {
        hasher,
        backupKeep: 10,
        createBackup: false,
        expectedContentHash: first.contentHash,
        platform: 'win32',
      }),
      writeNotebookFile(second, target, {
        hasher,
        backupKeep: 10,
        createBackup: false,
        expectedContentHash: second.contentHash,
        platform: 'win32',
      }),
    ]);
    const rejected = results.filter((entry) => entry.status === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const entry of rejected) {
      expect((entry as PromiseRejectedResult).reason).toMatchObject({ code: 'file_changed' });
    }
    // The winner's content is what is on disk (no torn write).
    expect(await readFile(target, 'utf8')).toContain('x =');
  });
});
