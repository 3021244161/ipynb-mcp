// U23 (R16): every static message template the server can emit is pure
// ASCII English. Dynamic values (paths, ids, numbers) interpolated via
// template literals are exempt per SPEC.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function isAscii(text: string): boolean {
  return [...text].every((ch) => ch.charCodeAt(0) <= 0x7f);
}

describe('[step9][U23] message templates are ASCII English (R16)', () => {
  it('every createWarning/new IpynbError message is ASCII', async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(5);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      // createWarning('code', 'message') and new IpynbError('code', 'message', ...)
      const warningPattern = /createWarning\(\s*'[^']*'\s*,\s*(`[^`]*`|'[^']*')/g;
      const errorPattern = /new IpynbError\(\s*'[^']*'\s*,\s*(`[^`]*`|'[^']*')/g;
      for (const pattern of [warningPattern, errorPattern]) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
          const template = match[1] ?? '';
          // Strip interpolation holes: static parts must be ASCII.
          const staticParts = template.replace(/\$\{[^}]*\}/g, '');
          if (!isAscii(staticParts)) {
            violations.push(`${path.relative(SRC_ROOT, file)}: ${template.slice(0, 80)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('tool descriptions registered with the server are ASCII (R16)', async () => {
    const descriptions = await Promise.all(
      ['read', 'edit', 'run', 'run-status', 'kernel'].map(async (name) => {
        const module = await import(`../../src/mcp/tools/${name}.ts`);
        return Object.values(module).find(
          (value): value is string => typeof value === 'string' && value.length > 40,
        );
      }),
    );
    for (const description of descriptions) {
      expect(description).toBeDefined();
      expect(isAscii(description ?? '')).toBe(true);
    }
  });
});
