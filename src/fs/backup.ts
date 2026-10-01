// Rolling backups (SPEC §5.9): `<dir>/<stem>.<yyyyMMdd-HHmmss>.ipynb.bak`,
// local time, `-<n>` suffix on same-second collisions, keep the newest
// `backupKeep` per notebook. Backups complete before the write starts.

import path from 'node:path';

import type { JsonValue } from '../core/errors.ts';

export interface BackupDeps {
  copyFile(src: string, dest: string): Promise<void>;
  readdir(dir: string): Promise<string[]> | string[];
  unlink(target: string): Promise<void>;
  now(): Date;
}

export interface BackupResult {
  /** Absolute path of the created backup; null when keep=0 (no backup requested). */
  readonly backupPath: string | null;
}

const BACKUP_RE = /^(\d{8}-\d{6})(?:-(\d+))?\.ipynb\.bak$/;

export async function createBackup(
  notebookPath: string,
  keep: number,
  deps: BackupDeps,
): Promise<BackupResult> {
  if (keep <= 0) {
    // backup_keep=0 means "retain no backups": creating one just to delete it
    // would defeat the purpose and burn an extra file write.
    return { backupPath: null };
  }
  const dir = path.dirname(notebookPath);
  const filename = path.basename(notebookPath);
  const stem = filename.endsWith('.ipynb') ? filename.slice(0, -'.ipynb'.length) : filename;

  const existing = await deps.readdir(dir);
  const existingBackups = existing
    .filter((name) => name.startsWith(`${stem}.`) && name.endsWith('.ipynb.bak'))
    .map((name) => parseBackupName(stem, name))
    .filter((entry): entry is { name: string; ts: string; n: number } => entry !== null)
    .sort(compareBackups);

  const ts = formatTimestamp(deps.now());
  let n = 0;
  const taken = new Set(existingBackups.map((b) => `${b.ts}#${b.n}`));
  while (taken.has(`${ts}#${n}`)) {
    n += 1;
  }
  const backupName = n === 0 ? `${stem}.${ts}.ipynb.bak` : `${stem}.${ts}-${n}.ipynb.bak`;
  const backupPath = path.join(dir, backupName);

  await deps.copyFile(notebookPath, backupPath);

  // Rolling retention: after adding the new backup, drop the oldest beyond `keep`.
  const allBackups = [...existingBackups, { name: backupName, ts, n }].sort(compareBackups);
  const excess = allBackups.length - keep;
  for (let i = 0; i < excess; i += 1) {
    const victim = allBackups[i];
    if (victim === undefined) {
      break;
    }
    await deps.unlink(path.join(dir, victim.name));
  }
  return { backupPath };
}

function parseBackupName(stem: string, name: string): { name: string; ts: string; n: number } | null {
  const rest = name.slice(stem.length + 1);
  const match = BACKUP_RE.exec(rest);
  if (match === null) {
    return null;
  }
  return { name, ts: match[1] ?? '', n: Number(match[2] ?? 0) };
}

function compareBackups(a: { ts: string; n: number }, b: { ts: string; n: number }): number {
  if (a.ts !== b.ts) {
    return a.ts < b.ts ? -1 : 1;
  }
  return a.n - b.n;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** JSON detail helper for write paths that report `backup_path`. */
export function backupPathDetail(backupPath: string | null): JsonValue {
  return { backup_path: backupPath };
}
