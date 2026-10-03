// Read/write orchestration for notebook files: parse + hash + optimistic-lock
// recheck + self check + backup + atomic write (SPEC §4.1.8, §5.5.5, §5.9, D12).
// Notebook STRUCTURE is core/parse's business; what this module owns is the file
// protocol around it: which errno becomes which error code (file_not_found /
// notebook_locked / file_changed) and the ordering of backup and rename.

import { copyFile, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { IpynbError } from '../core/errors.js';
import {
  parseNotebook,
  selfCheckNotebook,
  serializeNotebook,
  structuralWarning,
  type Hasher,
  type NotebookFile,
} from '../core/parse.js';
import { normalizeForCompare } from '../config.js';
import { atomicWriteFile, isLockError } from './atomic.js';
import { createBackup } from './backup.js';

export interface ReadFileDeps {
  /**
   * Byte reader. Injectable because the lock mapping below is otherwise only
   * reachable with a real OS-level exclusive handle (Windows-only I15), and a
   * function-body test of `translateLockError` does not prove the read path
   * calls it (review v3 TST-7).
   */
  readonly readFileImpl?: (target: string) => Promise<Uint8Array>;
}

export async function readNotebookFile(
  absolutePath: string,
  hasher: Hasher,
  deps: ReadFileDeps = {},
): Promise<NotebookFile> {
  const readBytes = deps.readFileImpl ?? readFile;
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(absolutePath);
  } catch (cause) {
    if (errnoCode(cause) === 'ENOENT') {
      throw new IpynbError('file_not_found', `notebook file not found: ${absolutePath}`, {
        path: absolutePath,
      });
    }
    // A file held open exclusively (Windows dwShareMode=0, an editor's lock)
    // fails the READ first, long before the backup/rename paths that already
    // map EBUSY/EPERM/EACCES. Without this, the model saw `internal` for a
    // condition the tool is supposed to name (SPEC §10.2 I15, review W1).
    throw translateLockError(cause, absolutePath);
  }
  return parseNotebook(bytes, hasher);
}

function translateLockError(cause: unknown, absolutePath: string): unknown {
  if (isLockError(cause)) {
    return new IpynbError('notebook_locked', `notebook file is locked by another process: ${absolutePath}`, {
      path: absolutePath,
    });
  }
  return cause;
}

/**
 * Map a filesystem failure on a notebook read to the documented error code.
 * Exported for tests: the real lock requires an OS-level exclusive handle,
 * which only the Windows integration case (I15) can create.
 */
export { translateLockError };

export interface WriteOptions {
  readonly hasher: Hasher;
  readonly backupKeep: number;
  readonly createBackup: boolean;
  /** Hash observed at read time; rechecked right before writing (SPEC §4.1.8). */
  readonly expectedContentHash?: string;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly onCleanupError?: (message: string) => void;
  /** Test injection point for corrupt serializers (U10). */
  readonly serialize?: (notebook: NotebookFile) => string;
  /**
   * Cells this write is responsible for. The structural self check only judges
   * these, so content that was already in the user's file (written by another
   * tool, or by an older version) cannot turn the notebook into a permanently
   * unwritable document (review v5 GATE-1). Omit only when the caller is
   * creating the document rather than editing one.
   */
  readonly touchedCellIndexes?: ReadonlySet<number>;
  /** Warning sink for pre-existing problems the write deliberately preserves. */
  readonly onStructuralWarning?: (message: string) => void;
}

export interface WriteResult {
  readonly backupPath: string | null;
  readonly contentHashAfter: string;
  readonly serialized: string;
}

/**
 * In-process per-path write mutex (review A17): the hash recheck and the
 * rename are individually correct but not atomic together — two concurrent
 * edits could both pass the recheck and the later rename silently dropped
 * the earlier one. Serialising the whole recheck->serialize->backup->rename
 * window per absolute path closes that TOCTOU within this process.
 *
 * Keys are normalised so `C:\NB.ipynb` and `c:/nb.ipynb` share one lock on
 * case-insensitive platforms (review W7), using the CALLER's platform rather
 * than the global one: `options.platform` is injected for a reason, and a test
 * running with `platform: 'linux'` on Windows must not silently inherit
 * Windows folding (review v3 ARCH-3).
 */
const writeLocks = new Map<string, Promise<unknown>>();

function lockKey(absolutePath: string, platform: NodeJS.Platform): string {
  return normalizeForCompare(path.resolve(absolutePath), platform);
}

async function withPathLock<T>(
  key: string,
  platform: NodeJS.Platform,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedKey = lockKey(key, platform);
  const prev = writeLocks.get(normalizedKey) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Store the REJECTION-SWALLOWED promise: the cleanup comparison must see the
  // same object that was stored. Building a fresh `.catch()` inside the
  // comparison made the delete branch dead code, so every path kept a settled
  // promise forever (review W7).
  const tail = next.catch(() => undefined);
  writeLocks.set(normalizedKey, tail);
  try {
    return await next;
  } finally {
    if (writeLocks.get(normalizedKey) === tail) {
      writeLocks.delete(normalizedKey);
    }
  }
}

export async function writeNotebookFile(
  notebook: NotebookFile,
  absolutePath: string,
  options: WriteOptions,
): Promise<WriteResult> {
  return withPathLock(
    absolutePath,
    options.platform ?? process.platform,
    () => writeNotebookFileUnlocked(notebook, absolutePath, options),
  );
}

/**
 * Number of paths still holding a write lock. Exported for tests: a lock leak
 * is invisible in behaviour (only memory), so the cleanup branch needs its own
 * assertion (review W7).
 */
export function pendingWriteLockCount(): number {
  return writeLocks.size;
}

async function writeNotebookFileUnlocked(
  notebook: NotebookFile,
  absolutePath: string,
  options: WriteOptions,
): Promise<WriteResult> {
  // Optimistic-lock recheck over the read->write window (SPEC §4.1.8):
  // even without expected_content_hash from the caller we compare the
  // on-disk bytes against what we parsed.
  let currentBytes: Uint8Array;
  try {
    currentBytes = await readFile(absolutePath);
  } catch (cause) {
    if (errnoCode(cause) === 'ENOENT') {
      throw new IpynbError('file_not_found', `notebook file not found: ${absolutePath}`, {
        path: absolutePath,
      });
    }
    throw translateLockError(cause, absolutePath);
  }
  const currentHash = `sha256:${options.hasher.sha256Hex(currentBytes)}`;
  const expected = options.expectedContentHash ?? notebook.contentHash;
  if (currentHash !== expected) {
    throw new IpynbError('file_changed', 'notebook file changed since it was read', {
      expected,
      actual: currentHash,
    });
  }

  const serialize = options.serialize ?? serializeNotebook;
  const serialized = serialize(notebook);
  // Self check before any byte lands on disk (SPEC §5.5.5); throws selfcheck_failed.
  // The scope is the cells this write changed, and content that was already
  // there is reported instead of refused — otherwise one historical quirk
  // anywhere in the file would make every edit and every run fail forever
  // (review v5 GATE-1).
  selfCheckNotebook(serialized, options.hasher, {
    touchedCellIndexes: options.touchedCellIndexes,
    ...(options.touchedCellIndexes === undefined
      ? {}
      : {
          onPreExistingProblem: (problem) => {
            options.onStructuralWarning?.(structuralWarning(problem));
          },
        }),
  });

  let backupPath: string | null = null;
  if (options.createBackup) {
    try {
      const result = await createBackup(absolutePath, options.backupKeep, {
        copyFile: (src, dest, flags) => copyFile(src, dest, flags),
        readdir: (dir) => readdir(dir),
        unlink: (target) => unlink(target),
        now: options.now ?? (() => new Date()),
        onRetentionError: (message) => options.onCleanupError?.(message),
      });
      backupPath = result.backupPath;
    } catch (cause) {
      // A held-open notebook blocks the backup copy too (Windows EBUSY etc.):
      // same lock semantics as the rename path (D12).
      if (isLockError(cause)) {
        throw new IpynbError(
          'notebook_locked',
          `notebook file is locked by another process: ${absolutePath}`,
          { path: absolutePath },
        );
      }
      throw cause;
    }
  }

  await atomicWriteFile(absolutePath, serialized, {
    signal: options.signal,
    platform: options.platform,
    onCleanupError: options.onCleanupError,
  });
  const contentHashAfter = `sha256:${options.hasher.sha256Hex(serialized)}`;
  return { backupPath, contentHashAfter, serialized };
}

function errnoCode(cause: unknown): string | undefined {
  if (cause instanceof Error && 'code' in cause) {
    return (cause as NodeJS.ErrnoException).code;
  }
  return undefined;
}
