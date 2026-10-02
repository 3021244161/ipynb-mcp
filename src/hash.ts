// Real hashing implementation (node:crypto). Injected into core/parse and
// core/edit so the core layer stays free of node:* imports (R11).

import { createHash } from 'node:crypto';

import type { Hasher } from './core/parse.js';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export const hasher: Hasher = { sha256Hex };
