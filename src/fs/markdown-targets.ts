// Markdown relative-target existence check (SPEC §5.7): the checker in
// core/markdown receives an injected existsSync, and this module is the fs
// side of that injection — the mcp tool layer must not import node:fs.
// The checker resolves relative targets itself and hands over ABSOLUTE paths.

import { existsSync } from 'node:fs';

export function markdownTargetExists(absolutePath: string): boolean {
  return existsSync(absolutePath);
}
