// Read/write orchestration for notebook files: parse + hash + optimistic-lock
// recheck + self check + backup + atomic write (SPEC §4.1.8, §5.5.5, §5.9, D12).
// Notebook semantics live in core/parse; this module only moves bytes.

import { copyFile, readFile, readdir, unlink } from 'node:fs/promises';

import { IpynbError } from '../core/errors.ts';
import {
  parseNotebook,
  selfCheckNotebook,
  serializeNotebook,
  type Hasher,
  type NotebookFile,
} from '../core/parse.ts';
import { atomicWriteFile } from './atomic.ts';
import { createBackup } from './backup.ts';

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

export async function writeNotebookFile(
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
    const result = await createBackup(absolutePath, options.backupKeep, {
      copyFile: (src, dest) => copyFile(src, dest),
      readdir: (dir) => readdir(dir),
      unlink: (target) => unlink(target),
      now: options.now ?? (() => new Date()),
    });
    backupPath = result.backupPath;
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
