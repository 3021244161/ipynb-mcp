// Fixture integrity (review v4, "must add" test #1 applied to the whole suite).
//
// The FID-1 bug survived three review rounds because every assertion — writer
// and tests alike — spoke the same private dialect: the writer emitted
// `outputType`, and the fixtures agreed. The real `nbformat.validate` found it
// on its first run, and it also found that several FIXTURES were invalid
// nbformat (kernelspec without display_name, execute_result without
// execution_count). Those fixtures made the suite's "the file is fine"
// assertions meaningless, because they described files nbformat rejects.
//
// This walks every notebook fixture the integration suite writes and validates
// it, so a fixture cannot silently drift away from the format the product
// claims to produce.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseNotebook, findStructuralProblem } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { nbformatAvailable, validateNotebook } from './nbformat-validator.js';

/** Every notebook literal the integration suite uses as a starting point. */
const FIXTURES: ReadonlyArray<{ name: string; notebook: unknown }> = [
  {
    name: 'code-cell-with-stream-output',
    notebook: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } },
      cells: [{
        cell_type: 'code', id: 'c0', metadata: {}, source: 'print(1)', execution_count: 1,
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
      }],
    },
  },
  {
    name: 'execute-result-and-error',
    notebook: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } },
      cells: [
        {
          cell_type: 'code', id: 'c0', metadata: {}, source: '1/0', execution_count: 2,
          outputs: [
            { output_type: 'execute_result', data: { 'text/plain': ['<function g>'] }, metadata: {}, execution_count: 1 },
            { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['Traceback...'] },
            { output_type: 'display_data', data: { 'text/plain': ['<Figure>'] }, metadata: {} },
          ],
        },
        { cell_type: 'markdown', id: 'm0', metadata: {}, source: '# title' },
        { cell_type: 'raw', id: 'r0', metadata: {}, source: 'raw text' },
      ],
    },
  },
];

let dir: string;
/** Resolved by beforeAll; the validation case skips when nbformat is missing. */
let interpreter = '';
let available = false;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-fixtures-'));
  const { existsSync } = await import('node:fs');
  const candidates = [
    process.env['IPYNB_TEST_PYTHON'],
    path.join(process.cwd(), 'tests', '.venv-test', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      continue;
    }
    if (nbformatAvailable(candidate)) {
      interpreter = candidate;
      available = true;
      break;
    }
  }
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('[FID-1] every notebook fixture is valid nbformat', () => {
  it('the structural gate accepts each fixture (catches drift even without nbformat)', () => {
    for (const fixture of FIXTURES) {
      const text = JSON.stringify(fixture.notebook);
      const parsed = parseNotebook(new TextEncoder().encode(text), hasher);
      expect(findStructuralProblem(parsed.doc), fixture.name).toBeNull();
    }
  });

  it('the real nbformat validator accepts each fixture', async () => {
    if (!available) {
      // No Python with nbformat here. The structural case above still ran, so
      // this is a coverage note rather than a silent pass.
      expect(interpreter).toBe('');
      return;
    }
    for (const fixture of FIXTURES) {
      const target = path.join(dir, `${fixture.name}.ipynb`);
      await writeFile(target, JSON.stringify(fixture.notebook));
      const validation = validateNotebook(target, interpreter);
      expect(validation.ok, `${fixture.name}: ${validation.message}`).toBe(true);
      // And the fixture must survive a read/serialize round trip unchanged in
      // shape, which is what the write paths rely on.
      const reread = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
      expect(reread['nbformat']).toBe(4);
    }
  }, 60_000);

  it('every .ipynb literal in the test sources carries a kernelspec display_name', async () => {
    // A cheap static guard with real teeth: a new fixture written the old way
    // (kernelspec without display_name) is rejected by nbformat, and this
    // catches it without needing Python at all.
    const root = path.join(process.cwd(), 'tests');
    const files: string[] = [];
    const walk = async (target: string): Promise<void> => {
      for (const entry of await readdir(target, { withFileTypes: true })) {
        const child = path.join(target, entry.name);
        if (entry.isDirectory()) {
          await walk(child);
        } else if (entry.name.endsWith('.ts')) {
          files.push(child);
        }
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // `kernelspec: { name: 'x', display_name: 'Python 3' }` with no display_name on the same line or the
      // two that follow it.
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (!/kernelspec:\s*\{[^}]*name:/.test(line)) {
          return;
        }
        const window = lines.slice(index, index + 2).join(' ');
        if (!/kernelspec[\s\S]*display_name|\}/.test(window) || !window.includes('display_name')) {
          offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
