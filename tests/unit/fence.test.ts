import { symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IpynbError } from '../../src/core/errors.js';
import { PathFence } from '../../src/fs/fence.js';

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

  it('rejects paths on another drive (win32 only)', () => {
    // "Another drive" is Windows-only semantics: on POSIX `D:/other/nb.ipynb` is
    // a RELATIVE path, so the fence resolves it under the root and correctly
    // allows it. Asserting the Windows outcome on every host demanded something
    // that cannot happen there (CI issue #1 problem 1b).
    if (process.platform !== 'win32') {
      // The reason is checked rather than assumed, so this is not a silent
      // "we did not look": a drive letter is just a directory name here.
      expect(path.isAbsolute('D:/other/nb.ipynb')).toBe(false);
      const fence = new PathFence(root, false, process.platform);
      expect(fence.assertInside('D:/other/nb.ipynb')).toContain('D:');
      return;
    }
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
    // Each platform gets its OWN expectation, which the title always claimed and
    // the body never did: the win32 branch was the only one asserted, and on
    // Linux the Windows spelling was mangled by the host's path handling
    // (CI issue #1 problem 1c).
    //
    // The assertion is on the FOLDING RULE (the normalized comparison), not on
    // the returned path's spelling, because the returned path is the caller's
    // spelling resolved — that part is host-independent and covered above.
    const folding = (platformRoot: string, candidate: string, platform: NodeJS.Platform): boolean => {
      const fence = new PathFence(platformRoot, false, platform);
      try {
        fence.assertInside(candidate);
        return true;
      } catch (cause) {
        if (cause instanceof IpynbError && cause.code === 'path_outside_root') {
          return false;
        }
        throw cause;
      }
    };

    expect(folding('C:/Work/Root', 'c:/work/root/nb.ipynb', 'win32')).toBe(true);
    expect(folding('/Work/Root', '/work/root/nb.ipynb', 'darwin')).toBe(true);
    // Linux is case-sensitive: the same spelling difference stays a different
    // path, which is the property the title promised to check.
    expect(folding('/work/Root', '/work/root/nb.ipynb', 'linux')).toBe(false);
    expect(folding('/work/root', '/work/root/nb.ipynb', 'linux')).toBe(true);
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

describe('[step2][A15] a relative root still fences correctly', () => {
  it('assertInside accepts notebook paths under a "." root', () => {
    const fence = new PathFence('.', false, process.platform);
    const resolved = fence.assertInside('nb.ipynb');
    // Resolved against the cwd, and recognised as inside.
    expect(path.isAbsolute(resolved.replace(/\//g, path.sep))).toBe(true);
    expect(fence.assertInside('./sub/nb.ipynb')).toContain('sub');
  });

  it('a relative root rejects paths outside the cwd', () => {
    const fence = new PathFence('.', false, process.platform);
    expectOutsideRoot(() => fence.assertInside('../outside.ipynb'));
  });
});
