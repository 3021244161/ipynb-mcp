// Read/write orchestration for notebook files: parse + hash + optimistic-lock
// recheck + self check + backup + atomic write (SPEC §4.1.8, §5.5.5, §5.9, D12).
// Notebook semantics live in core/parse; this module only moves bytes.

import { copyFile, readFile, readdir, unlink } from 'node:fs/promises';

import { IpynbError } from '../core/errors.js';
import {
  parseNotebook,
  selfCheckNotebook,
  serializeNotebook,
  type Hasher,
  type NotebookFile,
} from '../core/parse.js';
import { atomicWriteFile, isLockError } from './atomic.js';
import { createBackup } from './backup.js';

export async function readNotebookFile(absolutePath: string, hasher: Hasher): Promise<NotebookFile> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolutePath);
  } catch (cause) {
    if (errnoCode(cause) === 'ENOENT') {
      throw new IpynbError('file_not_found', `notebook file not found: ${absolutePath}`, {
        path: absolutePath,
      });
    }
    throw cause;
  }
  return parseNotebook(bytes, hasher);
}

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
 */
const writeLocks = new Map<string, Promise<unknown>>();

async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(key, next.catch(() => undefined));
  try {
    return await next;
  } finally {
    if (writeLocks.get(key) === next.catch(() => undefined)) {
      writeLocks.delete(key);
    }
  }
}

export async function writeNotebookFile(
  notebook: NotebookFile,
  absolutePath: string,
  options: WriteOptions,
): Promise<WriteResult> {
  return withPathLock(absolutePath, () => writeNotebookFileUnlocked(notebook, absolutePath, options));
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
    throw cause;
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
  selfCheckNotebook(serialized, options.hasher);

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
