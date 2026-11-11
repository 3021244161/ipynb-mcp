import { existsSync } from 'node:fs';
import { link, lstat, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { normalizeForCompare } from '../config.js';
import { IpynbError } from '../core/errors.js';
import type { ExportFormat } from '../core/export.js';
import { isLockError, lockErrno } from './atomic.js';
import { PathFence } from './fence.js';

export function defaultExportPath(notebookPath: string, format: ExportFormat): string {
  const ext = path.extname(notebookPath);
  return `${notebookPath.slice(0, ext === '' ? undefined : -ext.length)}.${format}`;
}

export async function assertExportDestination(
  fence: PathFence,
  notebookPath: string,
  outputPath: string,
  format: ExportFormat,
  overwrite: boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  fence.assertInside(notebookPath);
  fence.assertInside(outputPath);
  try {
    const parent = await stat(path.dirname(outputPath));
    if (!parent.isDirectory()) {
      throw new IpynbError('invalid_arguments', 'output_path parent must be an existing directory');
    }
  } catch (cause) {
    if (lockErrno(cause) === 'ENOENT' || lockErrno(cause) === 'ENOTDIR') {
      throw new IpynbError('invalid_arguments', 'output_path parent must be an existing directory');
    }
    throw cause;
  }
  if (path.extname(outputPath).toLowerCase() !== `.${format}` || /[:]/.test(path.basename(outputPath))) {
    throw new IpynbError('invalid_arguments', `output_path must have a .${format} extension and a regular filename`);
  }
  if (normalizeForCompare(notebookPath, platform) === normalizeForCompare(outputPath, platform)) {
    throw new IpynbError('invalid_arguments', 'output_path must not replace the source notebook');
  }
  try {
    const target = await lstat(outputPath);
    const source = await stat(notebookPath);
    if (!target.isFile() || target.isSymbolicLink() || (source.ino !== 0 && source.ino === target.ino && source.dev === target.dev)) {
      throw new IpynbError('invalid_arguments', 'output_path must be a regular file distinct from the source notebook');
    }
    if (!overwrite) {
      throw new IpynbError('invalid_arguments', 'output_path already exists; choose another path or set overwrite=true', { output_path: outputPath });
    }
  } catch (cause) {
    if (lockErrno(cause) !== 'ENOENT') {
      throw cause;
    }
  }
}

export async function createExportWorkspace(fence: PathFence, outputPath: string): Promise<string> {
  const prefix = fence.assertInside(path.join(path.dirname(outputPath), '.ipynb-export-'));
  return mkdtemp(prefix);
}

export async function writeExportBytes(target: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishExportFile(
  temporaryPath: string,
  outputPath: string,
  overwrite: boolean,
): Promise<void> {
  try {
    if (overwrite) {
      await rename(temporaryPath, outputPath);
    } else {
      // An exclusive hard link publishes complete bytes without a check/write race.
      // Both paths are on the same filesystem, inside the destination directory.
      await link(temporaryPath, outputPath);
    }
  } catch (cause) {
    if (lockErrno(cause) === 'EEXIST') {
      throw new IpynbError('invalid_arguments', 'output_path already exists; choose another path or set overwrite=true', { output_path: outputPath });
    }
    if (isLockError(cause)) {
      throw new IpynbError('notebook_locked', 'export destination is locked or not writable', { output_path: outputPath, errno: lockErrno(cause) ?? null });
    }
    throw new IpynbError('internal', 'could not publish the export file', { output_path: outputPath, errno: lockErrno(cause) ?? null });
  }
}

export async function removeExportWorkspace(workspace: string, fence: PathFence): Promise<void> {
  const resolved = path.resolve(workspace);
  fence.assertInside(resolved);
  if (!path.basename(resolved).startsWith('.ipynb-export-') || resolved === path.resolve(fence.root)) {
    throw new IpynbError('internal', 'refused to remove an unexpected export workspace');
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

export function findExportBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (target: string) => boolean = existsSync,
): string {
  const candidates: string[] = [];
  if (platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]) {
      if (base !== undefined) {
        candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      }
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  }
  // Ubuntu can deny the namespace sandbox to standalone Chromium snapshots.
  // Prefer installed Chrome/Edge across PATH before trying those builds.
  const names = platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'chromium.exe'] : ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser'];
  const directories = (env['PATH'] ?? '').split(platform === 'win32' ? ';' : ':').filter((dir) => dir !== '');
  for (const name of names) {
    for (const dir of directories) {
      candidates.push(path.join(dir, name));
    }
  }
  const found = candidates.find(exists);
  if (found === undefined) {
    throw new IpynbError('invalid_arguments', 'PDF/PNG export requires a local Chrome, Edge or Chromium installation; HTML export does not require a browser');
  }
  return found;
}
