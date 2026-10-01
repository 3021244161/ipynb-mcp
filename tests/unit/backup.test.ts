import { copyFile, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBackup, type BackupDeps } from '../../src/fs/backup.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-backup-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixedClock(...isoTimes: readonly string[]): BackupDeps {
  let call = 0;
  return {
    copyFile: (src, dest) => copyFile(src, dest),
    readdir: (d) => readdir(d),
    unlink: (t) => unlink(t),
    now: () => new Date(isoTimes[Math.min(call++, isoTimes.length - 1)] ?? isoTimes[isoTimes.length - 1] ?? ''),
  };
}

async function listBackups(): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith('.ipynb.bak')).sort();
}

describe('[step2] createBackup (SPEC §5.9)', () => {
  it('names the backup <stem>.<yyyyMMdd-HHmmss>.ipynb.bak using local time', async () => {
    const nb = path.join(dir, 'analysis.ipynb');
    await writeFile(nb, 'v1');
    const deps = fixedClock('2026-01-02T10:15:30');
    const { backupPath } = await createBackup(nb, 10, deps);
    expect(backupPath).toBe(path.join(dir, 'analysis.20260102-101530.ipynb.bak'));
    expect(await readFile(backupPath!, 'utf8')).toBe('v1');
  });

  it('appends -1, -2 on same-second collisions', async () => {
    const nb = path.join(dir, 'collide.ipynb');
    await writeFile(nb, 'v1');
    const deps = fixedClock('2026-01-02T10:15:30', '2026-01-02T10:15:30', '2026-01-02T10:15:30');
    const first = (await createBackup(nb, 10, deps)).backupPath;
    const second = (await createBackup(nb, 10, deps)).backupPath;
    const third = (await createBackup(nb, 10, deps)).backupPath;
    expect(first).toContain('collide.20260102-101530.ipynb.bak');
    expect(second).toContain('collide.20260102-101530-1.ipynb.bak');
    expect(third).toContain('collide.20260102-101530-2.ipynb.bak');
  });

  it('keeps only the newest backup_keep backups per notebook stem', async () => {
    const nb = path.join(dir, 'rolling.ipynb');
    await writeFile(nb, 'v1');
    // Three distinct seconds, keep=2 -> the oldest must be deleted.
    const deps = fixedClock('2026-01-02T10:15:31', '2026-01-02T10:15:32', '2026-01-02T10:15:33');
    await createBackup(nb, 2, deps);
    await createBackup(nb, 2, deps);
    const last = await createBackup(nb, 2, deps);
    const backups = await listBackups();
    const rolling = backups.filter((name) => name.startsWith('rolling.'));
    expect(rolling).toEqual([
      'rolling.20260102-101532.ipynb.bak',
      'rolling.20260102-101533.ipynb.bak',
    ]);
    expect(last.backupPath).toContain('101533');
  });

  it('returns null and writes nothing when keep=0', async () => {
    const nb = path.join(dir, 'nobackup.ipynb');
    await writeFile(nb, 'v1');
    const before = await listBackups();
    const { backupPath } = await createBackup(nb, 0, fixedClock('2026-01-02T10:15:30'));
    expect(backupPath).toBeNull();
    expect(await listBackups()).toEqual(before);
  });

  it('does not touch backups of other notebooks', async () => {
    const a = path.join(dir, 'other-a.ipynb');
    const b = path.join(dir, 'other-b.ipynb');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    const deps = fixedClock('2026-01-02T10:15:40', '2026-01-02T10:15:41', '2026-01-02T10:15:42');
    await createBackup(a, 1, deps);
    await createBackup(a, 1, deps);
    await createBackup(b, 1, deps);
    const backups = await listBackups();
    // other-a rolled to keep=1, other-b untouched with its 1 backup.
    expect(backups.filter((n) => n.startsWith('other-a.'))).toEqual([
      'other-a.20260102-101541.ipynb.bak',
    ]);
    expect(backups.filter((n) => n.startsWith('other-b.'))).toEqual([
      'other-b.20260102-101542.ipynb.bak',
    ]);
  });
});

async function readFile(target: string, encoding: 'utf8'): Promise<string> {
  const { readFile: read } = await import('node:fs/promises');
  return read(target, encoding);
}
