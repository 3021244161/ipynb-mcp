// Path fence (D17/R6): all notebook paths must resolve inside the configured
// root unless --allow-outside-root is set. Comparison happens on realpath with
// win32/darwin case folding (SPEC §5.3) — without it the same file can slip
// past the fence through casing differences or symlinks.

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { normalizeForCompare } from '../config.ts';
import { IpynbError } from '../core/errors.ts';

export interface FenceDeps {
  /** Realpath of an existing path; implementations should throw when it does not exist. */
  realpathSync(target: string): string;
}

const DEFAULT_DEPS: FenceDeps = { realpathSync };

export class PathFence {
  readonly #root: string;
  readonly #rootNorm: string;
  readonly #rootRealNorm: string;
  readonly #allowOutside: boolean;
  readonly #platform: NodeJS.Platform;
  readonly #deps: FenceDeps;

  constructor(
    root: string,
    allowOutsideRoot: boolean,
    platform: NodeJS.Platform,
    deps: FenceDeps = DEFAULT_DEPS,
  ) {
    this.#root = root;
    this.#allowOutside = allowOutsideRoot;
    this.#platform = platform;
    this.#deps = deps;
    this.#rootNorm = normalizeForCompare(toPosix(root), platform);
    this.#rootRealNorm = this.#realpathOrSelf(root);
  }

  /** Resolve an input path (absolute, or relative to root) to an absolute path with `/` separators. */
  resolve(input: string): string {
    const absolute = path.isAbsolute(input) ? input : path.join(this.#root, input);
    return toPosix(path.resolve(absolute));
  }

  /**
   * Resolve and enforce the fence. Returns the absolute resolved path.
   * Throws `path_outside_root` when the target escapes the root.
   */
  assertInside(input: string): string {
    const resolved = this.resolve(input);
    if (this.#allowOutside) {
      return resolved;
    }
    if (!this.#isInsideStringNorm(resolved)) {
      throw new IpynbError('path_outside_root', `path is outside the server root: ${resolved}`, {
        root: this.#root,
        path: resolved,
      });
    }
    // Symlink escape: a path that is lexically inside the root may point
    // outside once resolved. Only checkable when the target exists.
    const realNorm = this.#realpathOrSelf(resolved);
    if (!this.#isInsideNorm(realNorm, this.#rootRealNorm)) {
      throw new IpynbError('path_outside_root', `path resolves outside the server root: ${resolved}`, {
        root: this.#root,
        path: resolved,
      });
    }
    return resolved;
  }

  get root(): string {
    return this.#root;
  }

  get allowOutsideRoot(): boolean {
    return this.#allowOutside;
  }

  #isInsideStringNorm(resolved: string): boolean {
    return this.#isInsideNorm(normalizeForCompare(resolved, this.#platform), this.#rootNorm);
  }

  #isInsideNorm(candidateNorm: string, rootNorm: string): boolean {
    return candidateNorm === rootNorm || candidateNorm.startsWith(rootNorm + '/');
  }

  #realpathOrSelf(target: string): string {
    try {
      return normalizeForCompare(toPosix(this.#deps.realpathSync(target)), this.#platform);
    } catch {
      // The final target does not exist. Walk up to the deepest existing
      // ancestor so a symlinked intermediate directory cannot hide an escape
      // behind a missing tail (root/escape-link/missing.ipynb).
      let current = toPosix(target);
      const tail: string[] = [];
      for (;;) {
        const parent = path.posix.dirname(current);
        if (parent === current) {
          // Nothing along the chain exists; the lexical check already ran.
          return normalizeForCompare(toPosix(target), this.#platform);
        }
        tail.unshift(path.posix.basename(current));
        current = parent;
        try {
          const real = toPosix(this.#deps.realpathSync(current));
          return normalizeForCompare(`${real}/${tail.join('/')}`, this.#platform);
        } catch {
          continue;
        }
      }
    }
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
