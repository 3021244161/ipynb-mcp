#!/usr/bin/env node
// Authority-document self check (review v9 V9-6).
//
// `docs/DEVIATIONS.md` is the ONLY register this project has for "we departed from
// SPEC, here is why", and v8 shipped it spliced onto itself: one row ended mid-token,
// the document header appeared a second time in the middle of that row, and every
// deviation from D-001 on was listed TWICE. Nothing noticed, because the gates look
// at code: `oxlint` does not read markdown, and both halves were individually
// well-formed enough to render.
//
// A register nobody can trust is worse than no register, so the invariants that broke
// are now checked:
//   1. exactly one document header and one table header per authority document;
//   2. every `D-0NN` / `QN` id appears exactly once, and the numbering has no gaps;
//   3. `docs/OPEN_QUESTIONS.md` is still a VERBATIM copy of SPEC §12 — the one thing
//      that file is for (AGENTS §12.2), and the thing most likely to drift silently
//      when SPEC changes.
//
// Falsifiability (AGENTS §9): `--selftest` runs every rule against a mutated corpus
// and requires each mutation to be caught. Run `node scripts/check-docs.mjs --selftest`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The documents whose structure is load-bearing, and what each must satisfy. */
const AUTHORITY_DOCS = [
  {
    file: 'docs/DEVIATIONS.md',
    header: '# DEVIATIONS — 每一次偏离 SPEC 的记录',
    tableHeader: '| # | 日期 | SPEC 位置 | 偏离内容 | 理由 | 影响面 | 状态 |',
    idPattern: /^\| (D-\d{3}) \|/gm,
    idPrefix: 'D-',
  },
];

function read(relative) {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** Every problem found, as a printable line. Empty array means "ok". */
export function inspectDocument(doc, text) {
  const problems = [];
  const lines = text.split('\n');

  const headerCount = lines.filter((line) => line.trim() === doc.header).length;
  if (headerCount !== 1) {
    problems.push(`${doc.file}: the document header appears ${String(headerCount)} times (must be exactly 1)`);
  }
  const tableHeaderCount = lines.filter((line) => line.trim() === doc.tableHeader).length;
  if (tableHeaderCount !== 1) {
    problems.push(`${doc.file}: the table header appears ${String(tableHeaderCount)} times (must be exactly 1)`);
  }

  const seen = new Map();
  for (const match of text.matchAll(doc.idPattern)) {
    const id = match[1];
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count !== 1) {
      problems.push(`${doc.file}: ${id} appears ${String(count)} times (each entry must appear exactly once)`);
    }
  }

  // Numbering must be contiguous from 001: a gap means a row was lost in an edit, and
  // a spliced document produces exactly that shape (a duplicated range hides it).
  const numbers = [...seen.keys()].map((id) => Number(id.slice(doc.idPrefix.length))).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) {
      problems.push(
        `${doc.file}: entry numbering has a gap at ${doc.idPrefix}${String(i + 1).padStart(3, '0')} (found ${doc.idPrefix}${String(numbers[i]).padStart(3, '0')})`,
      );
      break;
    }
  }

  // A row is ONE line with the table's arity. Cells are split on ` | ` rather than on
  // every `|`: the deviation text legitimately contains pipes (a regex, a `||`), and
  // counting raw pipes reported a false positive on the real file — which is how this
  // rule earned its shape.
  //
  // Note the limit of this check: a row that WRAPS onto a following line still has the
  // declared arity on its own line, so arity cannot see it. What catches the v9 splice
  // is the header rule and the id rules — the pasted copy brought a second header and a
  // second run of every id — and those are asserted by mutation in `--selftest`.
  const declaredCells = doc.tableHeader.split(' | ').length;
  for (const line of lines) {
    if (!/^\| D-\d{3} \|/.test(line)) {
      continue;
    }
    const cells = line.trimEnd().split(' | ').length;
    if (cells !== declaredCells) {
      problems.push(
        `${doc.file}: row ${line.slice(0, 12)}… has ${String(cells)} cells, the table declares ${String(declaredCells)}`,
      );
    }
  }

  return problems;
}

/** SPEC §12, verbatim, as `docs/OPEN_QUESTIONS.md` must carry it. */
export function inspectOpenQuestions(specText, openQuestionsText) {
  const problems = [];
  const start = specText.indexOf('## 12. 需要人类决定的事项');
  if (start < 0) {
    problems.push('SPEC.md: §12 heading not found, so the verbatim claim cannot be checked');
    return problems;
  }
  const rest = specText.slice(start);
  const end = rest.indexOf('\n---', 1);
  const section = (end < 0 ? rest : rest.slice(0, end)).trimEnd();
  const body = openQuestionsText.slice(openQuestionsText.indexOf('## 12.')).trimEnd();
  if (body !== section) {
    // Report the first differing line rather than the whole section: the point is to
    // say WHERE the copy drifted, and these are documents a human reads.
    const expected = section.split('\n');
    const actual = body.split('\n');
    const at = expected.findIndex((line, index) => line !== actual[index]);
    problems.push(
      `docs/OPEN_QUESTIONS.md: §12 is not a verbatim copy of SPEC.md (first difference at line ${String(at + 1)}: expected ${JSON.stringify(expected[at] ?? '<missing>')}, found ${JSON.stringify(actual[at] ?? '<missing>')})`,
    );
  }
  return problems;
}

function inspectRepository() {
  const problems = [];
  for (const doc of AUTHORITY_DOCS) {
    problems.push(...inspectDocument(doc, read(doc.file)));
  }
  problems.push(...inspectOpenQuestions(read('SPEC.md'), read('docs/OPEN_QUESTIONS.md')));
  return problems;
}

/**
 * Break each rule on purpose and require the checker to notice.
 *
 * Without this the whole script is decoration: a rule that cannot fail and a rule
 * that is not written look identical from the outside (AGENTS §9, "守卫必须自己证明
 * 有判别力").
 */
function selftest() {
  const doc = AUTHORITY_DOCS[0];
  const original = read(doc.file);

  /** Replace the first line starting with `prefix`, by line rather than by regex. */
  const editLine = (text, prefix, change) => {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.startsWith(prefix));
    if (at < 0) {
      throw new Error(`self-test setup: no line starts with ${JSON.stringify(prefix)}`);
    }
    lines.splice(at, 1, ...(change === null ? [] : [change(lines[at])]));
    return lines.join('\n');
  };

  const cases = [
    {
      name: 'the document header is duplicated (the v9 shape: a spliced copy)',
      text: `${original}\n${original}`,
      expect: 'document header appears 2 times',
    },
    {
      name: 'a row is duplicated by a partial re-paste',
      text: editLine(original, '| D-001 |', (line) => `${line}\n${line}`),
      expect: 'D-001 appears 2 times',
    },
    {
      name: 'an entry was lost in an edit (numbering gap)',
      text: editLine(original, '| D-007 |', () => null),
      expect: 'numbering has a gap',
    },
    {
      name: 'a row was spliced onto the pasted copy (the v9 symptom, at row scale)',
      // The v9 file had a row that ran on into the pasted copy's header. At row scale
      // the same defect shows up as a lost cell boundary, which is what this asserts.
      text: editLine(original, '| D-044 |', (line) => line.replace(' | 已实现', ' 已实现')),
      expect: 'cells, the table declares',
    },
    {
      name: 'a second table header was pasted in',
      text: original.replace(doc.tableHeader, `${doc.tableHeader}\n${doc.tableHeader}`),
      expect: 'table header appears 2 times',
    },
  ];

  const problems = [];
  for (const testCase of cases) {
    const found = inspectDocument(doc, testCase.text);
    if (!found.some((problem) => problem.includes(testCase.expect))) {
      problems.push(`self-test [${testCase.name}]: expected a problem containing ${JSON.stringify(testCase.expect)}, got ${JSON.stringify(found)}`);
    }
  }

  const spec = read('SPEC.md');
  const openQuestions = read('docs/OPEN_QUESTIONS.md');
  const driftCases = [
    { name: 'a Q row was reworded', text: openQuestions.replace('| 保持 20 |', '| 20 is fine |'), expect: 'not a verbatim copy' },
    { name: 'a Q row was deleted', text: openQuestions.replace(/^\| Q3 \|[^\n]*\n/m, ''), expect: 'not a verbatim copy' },
  ];
  for (const testCase of driftCases) {
    const found = inspectOpenQuestions(spec, testCase.text);
    if (!found.some((problem) => problem.includes(testCase.expect))) {
      problems.push(`self-test [${testCase.name}]: expected ${JSON.stringify(testCase.expect)}, got ${JSON.stringify(found)}`);
    }
  }

  // The control: the real documents must pass, or every mutation above would be
  // "detected" by a checker that reports something unconditionally.
  const controlProblems = inspectRepository();
  if (controlProblems.length > 0) {
    problems.push(`self-test [control]: the real documents report problems: ${controlProblems.join('; ')}`);
  }

  if (problems.length > 0) {
    process.stdout.write(`documentation self-test failed (${String(problems.length)}):\n`);
    for (const problem of problems) {
      process.stdout.write(`- ${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `documentation self-test: ok (${String(cases.length + driftCases.length)} mutations detected, control clean)\n`,
  );
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  const problems = inspectRepository();
  if (problems.length > 0) {
    process.stdout.write(`documentation check failed (${String(problems.length)}):\n`);
    for (const problem of problems) {
      process.stdout.write(`- ${problem}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `documentation check: ok (${String(AUTHORITY_DOCS.length)} authority document(s), SPEC §12 verbatim)\n`,
    );
  }
}
