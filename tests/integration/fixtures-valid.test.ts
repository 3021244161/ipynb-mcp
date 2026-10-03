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
// This file has two layers, and the review was right that the first version
// over-claimed (TEST-1): it said "every notebook fixture the integration suite
// writes" while checking two hand-written literals.
//
//   1. REPRESENTATIVE literals (below): the two shapes the product must produce,
//      judged by both our own gate and the real validator, so the two cannot
//      drift apart.
//   2. A STATIC sweep over `tests/**/*.ts` (the last case) that enforces the rule
//      which actually bit us — a kernelspec without `display_name` — on every
//      literal in the suite, without needing to parse the suite's source.
//
// Layer 2 is deliberately narrow: extracting arbitrary notebook literals from
// test sources and validating them is a parsing problem of its own, and a
// half-working extractor would give the same false confidence this file was
// criticised for. What it can do honestly is check the one field that was
// missing in nine places.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseNotebook, findStructuralProblem } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { nbformatAvailable, nbformatSkipReason, validateNotebook } from './nbformat-validator.js';
import { TEST_VENV_PY } from './test-venv.js';

/**
 * Representative notebook literals: the shapes the write paths must be able to
 * produce and read back. Not an exhaustive list of the suite's fixtures — see
 * the header for what the second layer covers.
 */
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
    TEST_VENV_PY,
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

  it('the real nbformat validator accepts each fixture', async (context) => {
    if (!available) {
      // The case is SKIPPED, not passed: `expect(interpreter).toBe('')` looked
      // like an assertion while actually asserting nothing, so on a machine (or a
      // CI job) without nbformat this file reported a green result for a check
      // that never ran — the failure mode review v7 P0-a is about. The reason is
      // in the test name now, and `IPYNB_REQUIRE_NBFORMAT=1` turns the absence
      // into a failure.
      // The interpreter the search DID select, not a fresh guess: the old call asked
      // the base interpreter, so a venv that had nbformat while the base did not
      // produced "nbformat is not importable" and skipped the check (review v8 V8-11).
      const reason = nbformatSkipReason(interpreter);
      context.skip(reason ?? 'no interpreter with nbformat was found');
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
      const raw = await readFile(file, 'utf8');
      // Strip comments first: prose about kernelspecs (including this very
      // explanation) is not a fixture, and matching it produced a self-inflicted
      // offender the first time this scan ran.
      const text = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      // Every `kernelspec: { ... }` literal must carry `display_name`; nbformat
      // rejects a kernelspec without it (nine of them did, before the v4 round).
      // The scan reads the whole object, including objects split across lines,
      // rather than a fixed number of following lines.
      const marker = /kernelspec:\s*\{/g;
      let match = marker.exec(text);
      while (match !== null) {
        const from = match.index + match[0].length - 1;
        // Walk braces to find this object's end (nested objects are unlikely in
        // a kernelspec, but a wrong end would only ever widen the window).
        let depth = 0;
        let end = from;
        for (let index = from; index < text.length; index += 1) {
          if (text[index] === '{') {
            depth += 1;
          } else if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) {
              end = index;
              break;
            }
          }
        }
        const literal = text.slice(from, end + 1);
        const line = text.slice(0, match.index).split('\n').length;
        if (!literal.includes('display_name')) {
          offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
        }
        match = marker.exec(text);
      }
    }
    expect(offenders).toEqual([]);
  });
});
