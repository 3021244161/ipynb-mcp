// Atomic write (D12): temp file in the same directory -> fsync -> rename over
// the target -> fsync the directory on POSIX. EBUSY/EPERM/EACCES on rename
// means another process holds the file (user has it open in Jupyter/VS Code)
// and maps to `notebook_locked`, never `internal`.

import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { IpynbError } from '../core/errors.js';

export interface AtomicWriteDeps {
  open(target: string, flags: string, mode: number): Promise<FileHandleLike>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  fsyncDir(dirPath: string): Promise<void>;
}

export interface FileHandleLike {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_DEPS: AtomicWriteDeps = {
  open: (target, flags, mode) => open(target, flags, mode) as Promise<FileHandleLike>,
  rename,
  unlink,
  fsyncDir: defaultFsyncDir,
};

export interface AtomicWriteOptions {
  /** Aborting before rename discards the temp file and leaves the target untouched (SPEC §4.6.2). */
  readonly signal?: AbortSignal;
  readonly deps?: AtomicWriteDeps;
  /** Default: process.platform. Windows skips the directory fsync (SPEC §9). */
  readonly platform?: NodeJS.Platform;
  /** Receives temp-file cleanup failures so they never mask the primary error. */
  readonly onCleanupError?: (message: string) => void;
}

export async function atomicWriteFile(
  absolutePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const deps = options.deps ?? DEFAULT_DEPS;
  const platform = options.platform ?? process.platform;
  const dir = path.dirname(absolutePath);
  const base = path.basename(absolutePath);
  // SPEC D12: temp file named `.<name>.tmp-<uuid>` in the same directory.
  const tmpPath = path.join(dir, `.${base}.tmp-${randomUUID()}`);
  let renamed = false;
  try {
    throwIfAborted(options.signal);
    const handle = await deps.open(tmpPath, 'wx', 0o666);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(options.signal);
    try {
      await deps.rename(tmpPath, absolutePath);
      renamed = true;
    } catch (cause) {
      if (isLockError(cause)) {
        throw new IpynbError(
          'notebook_locked',
          `notebook file is locked by another process: ${absolutePath}`,
          { path: absolutePath },
        );
      }
      throw cause;
    }
  } catch (cause) {
    if (!renamed) {
      await cleanupTempFile(deps, tmpPath, options.onCleanupError);
    }
    throw cause;
  }
  if (platform !== 'win32') {
    // Rename already landed: the file itself is fsynced and safe. A directory
    // fsync failure only weakens crash recovery of the directory entry, so it
    // must NOT turn an already-successful write into a reported failure
    // (review A13 — a "failed" edit whose file actually changed confuses the
    // one-retry contract with a stale anchor).
    try {
      await deps.fsyncDir(dir);
    } catch (cause) {
      const sink = options.onCleanupError ?? ((message: string) => process.stderr.write(`${message}
`));
      sink(`[ipynb-mcp] warn directory fsync failed for ${dir}: ${String(cause)}`);
    }
  }
}

async function cleanupTempFile(
  deps: AtomicWriteDeps,
  tmpPath: string,
  onCleanupError?: (message: string) => void,
): Promise<void> {
  try {
    await deps.unlink(tmpPath);
  } catch (cleanupCause) {
    if (isNotFound(cleanupCause)) {
      return;
    }
    // Re-throwing would mask the primary failure (e.g. notebook_locked);
    // report through the sink instead. R7 satisfied: error is surfaced, not swallowed.
    const sink = onCleanupError ?? ((message: string) => process.stderr.write(`${message}\n`));
    sink(`[ipynb-mcp] warn failed to remove temp file ${tmpPath}: ${String(cleanupCause)}`);
  }
}

export function isLockError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    ('code' in cause &&
      ((cause as NodeJS.ErrnoException).code === 'EBUSY' ||
        (cause as NodeJS.ErrnoException).code === 'EPERM' ||
        (cause as NodeJS.ErrnoException).code === 'EACCES'))
  );
}

function isNotFound(cause: unknown): boolean {
  return (
    cause instanceof Error && 'code' in cause && (cause as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
}

async function defaultFsyncDir(dirPath: string): Promise<void> {
  const handle = await open(dirPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
