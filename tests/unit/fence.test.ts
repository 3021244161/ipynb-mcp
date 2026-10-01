import { symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IpynbError } from '../../src/core/errors.ts';
import { PathFence } from '../../src/fs/fence.ts';

let workspace: string;
let root: string;
let outside: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-fence-'));
  root = path.join(workspace, 'root');
  outside = path.join(workspace, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await writeFile(path.join(root, 'nb.ipynb'), '{}');
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function expectOutsideRoot(action: () => unknown): void {
  try {
    action();
    expect.unreachable('expected path_outside_root');
  } catch (cause) {
    expect(cause).toBeInstanceOf(IpynbError);
    expect((cause as IpynbError).code).toBe('path_outside_root');
  }
}

describe('[step2][U11] PathFence enforcement', () => {
  it('rejects an absolute path outside the root', () => {
    const fence = new PathFence(root, false, process.platform);
    expectOutsideRoot(() => fence.assertInside(path.join(outside, 'nb.ipynb')));
  });

  it('rejects a relative path escaping via ..', () => {
    const fence = new PathFence(root, false, process.platform);
    expectOutsideRoot(() => fence.assertInside('../outside/nb.ipynb'));
    expectOutsideRoot(() => fence.assertInside('..\\outside\\nb.ipynb'));
  });

  it('rejects paths on another drive (win32)', () => {
    const fence = new PathFence('C:/work/root', false, 'win32');
    expectOutsideRoot(() => fence.assertInside('D:/other/nb.ipynb'));
  });

  it('allows outside paths when --allow-outside-root is set', () => {
    const fence = new PathFence(root, true, process.platform);
    const resolved = fence.assertInside(path.join(outside, 'nb.ipynb'));
    expect(resolved).toContain('outside');
  });

  it('accepts paths inside the root, absolute and relative, with / separators', () => {
    const fence = new PathFence(root, false, process.platform);
    const absolute = fence.assertInside(path.join(root, 'sub', 'nb.ipynb'));
    expect(absolute).toBe(path.join(root, 'sub', 'nb.ipynb').replace(/\\/g, '/'));
    expect(fence.assertInside('sub/nb.ipynb')).toBe(absolute);
    expect(fence.assertInside('./sub/../sub/nb.ipynb')).toBe(absolute);
  });

  it('folds case on win32/darwin but not on linux', () => {
    const win = new PathFence('C:/Work/Root', false, 'win32');
    expect(win.assertInside('c:/work/root/nb.ipynb')).toBe('C:/work/root/nb.ipynb'.replace('C:', 'c:').replace('c:', 'c:'));
    const linux = new PathFence('/work/Root', false, 'linux');
    expectOutsideRoot(() => linux.assertInside('/work/root/nb.ipynb'));
  });

  it('accepts a non-existent path inside the root (file_not_found is a later concern)', () => {
    const fence = new PathFence(root, false, process.platform);
    expect(fence.assertInside('missing.ipynb')).toContain('missing.ipynb');
  });

  it('blocks symlink escapes through realpath', (context) => {
    const linkPath = path.join(root, 'escape');
    try {
      symlinkSync(outside, linkPath, 'junction');
    } catch {
      context.skip('symlink creation not permitted on this machine');
      return;
    }
    const fence = new PathFence(root, false, process.platform);
    expectOutsideRoot(() => fence.assertInside('escape/secret.ipynb'));
  });
});
