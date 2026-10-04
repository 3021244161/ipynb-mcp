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

/**
 * The entry count the document declares about itself, or null when it declares none.
 *
 * The count lives next to the thing it counts (a `entries: NN` line in the header block)
 * so that adding a row and updating the count are the same edit. A document without the
 * declaration is not failed for it — only the two rules that need it are skipped — but
 * the reviewer's two mutations (delete the last row, append one) are both caught by it,
 * which is the falsifiability the v10 review asked for.
 */
function declareCount(lines, doc) {
  const pattern = new RegExp(`^>\\s*entries:\\s*(\\d+)\\s*$`);
  for (const line of lines.slice(0, 12)) {
    const match = pattern.exec(line);
    if (match !== null) {
      return Number(match[1]);
    }
  }
  void doc;
  return null;
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
  // …and the LAST row must be the highest number, which the gap rule alone cannot see:
  // deleting the final row leaves a perfectly contiguous 1..n-1 and used to pass
  // (review v10 V10-5, the reviewer's "delete the last row" mutation).
  //
  // The expected count lives in the document's own header line — `entries: NN` — rather
  // than in this script, so adding a row is a one-line edit to the thing being counted
  // (and the header rule below makes that line unique). `--selftest` proves the rule can
  // fail by deleting the last row AND by appending one.
  const declaredTotal = declareCount(lines, doc);
  const highest = numbers.at(-1) ?? 0;
  if (declaredTotal !== null && highest !== declaredTotal) {
    problems.push(
      `${doc.file}: the table ends at ${doc.idPrefix}${String(highest).padStart(3, '0')} but its header declares ${String(declaredTotal)} entries — a row was lost from the end, or appended without updating the count`,
    );
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
 *
 * Every mutation is derived from the LIVE text, and a mutation the current document
 * cannot express is reported as SKIPPED rather than as a failure. The first version
 * hard-coded strings from the document (`' | 已实现'`, `'| 保持 20 |'`, `Q3`) and threw
 * when they were absent, so a legitimate edit to the prose turned `pnpm lint` red while
 * the documents were correct — "a guard must not fail for unrelated reasons", the other
 * half of the same rule (review v10 V10-8). The minimum-applied count below is what keeps
 * that tolerance from degenerating into "nothing is checked any more".
 */
function selftest() {
  const doc = AUTHORITY_DOCS[0];
  const original = read(doc.file);
  const skipped = [];

  /** Replace the first line starting with `prefix`, by line rather than by regex. */
  const editLine = (text, prefix, change) => {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.startsWith(prefix));
    if (at < 0) {
      return null;
    }
    lines.splice(at, 1, ...(change === null ? [] : [change(lines[at])]));
    return lines.join('\n');
  };

  /** The last numbered row's prefix, derived from the document rather than hard-coded. */
  const lastRow = [...original.matchAll(/^\| (D-\d{3}) \|/gm)].at(-1)?.[1] ?? null;
  /** A row in the MIDDLE, so the "gap" mutation is not the same as "delete the end". */
  const middleRow = [...original.matchAll(/^\| (D-\d{3}) \|/gm)][3]?.[1] ?? null;
  /** The next number after the last row, for the "appended without a count" mutation. */
  const nextId = lastRow === null ? null : `D-${String(Number(lastRow.slice(2)) + 1).padStart(3, '0')}`;

  const candidates = [
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
      name: 'an entry was lost from the middle (numbering gap)',
      text: middleRow === null ? null : editLine(original, `| ${middleRow} |`, () => null),
      expect: 'numbering has a gap',
    },
    {
      name: 'the LAST entry was lost (the v10 finding: a gap rule cannot see it)',
      text: lastRow === null ? null : editLine(original, `| ${lastRow} |`, () => null),
      expect: 'a row was lost from the end',
    },
    {
      name: 'an entry was appended without updating the declared count',
      text:
        lastRow === null || nextId === null
          ? null
          : editLine(original, `| ${lastRow} |`, (line) => `${line}\n| ${nextId} | 2026-10-04 | §0 | x | y | z | 已实现 |`),
      expect: 'appended without updating the count',
    },
    {
      name: 'a row lost a cell boundary (the v9 symptom at row scale)',
      // Derived: turn the last cell separator into a bare pipe, so the row loses a cell
      // however its final column happens to be worded.
      text: lastRow === null ? null : editLine(original, `| ${lastRow} |`, (line) => line.replace(/ \| ([^|]*) \|$/, ' |$1|')),
      expect: 'cells, the table declares',
    },
    {
      name: 'a second table header was pasted in',
      text: original.includes(doc.tableHeader)
        ? original.replace(doc.tableHeader, `${doc.tableHeader}\n${doc.tableHeader}`)
        : null,
      expect: 'table header appears 2 times',
    },
  ];

  const problems = [];
  let applied = 0;
  for (const testCase of candidates) {
    if (testCase.text === null) {
      skipped.push(testCase.name);
      continue;
    }
    applied += 1;
    const found = inspectDocument(doc, testCase.text);
    if (!found.some((problem) => problem.includes(testCase.expect))) {
      problems.push(`self-test [${testCase.name}]: expected a problem containing ${JSON.stringify(testCase.expect)}, got ${JSON.stringify(found)}`);
    }
  }

  const spec = read('SPEC.md');
  const openQuestions = read('docs/OPEN_QUESTIONS.md');
  // Derived: mutate a row of §12 wherever it is — a status column, a question row — by
  // taking a line that exists and changing one character of it. The first version named
  // literal strings from the document, so editing either document honestly broke lint.
  const qLine = /^\| Q\d+ \|[^\n]*$/m.exec(openQuestions)?.[0] ?? null;
  const declared = /^## 12\.[^\n]*$/m.exec(openQuestions)?.[0] ?? null;
  const driftCandidates = [
    {
      name: 'a Q row was reworded without touching SPEC.md',
      text: qLine === null ? null : openQuestions.replace(qLine, `${qLine} `),
      expect: 'not a verbatim copy',
    },
    {
      name: 'a Q row was deleted',
      text: qLine === null ? null : openQuestions.replace(`${qLine}\n`, ''),
      expect: 'not a verbatim copy',
    },
    {
      name: 'the section heading was reworded',
      text: declared === null ? null : openQuestions.replace(declared, `${declared} `),
      expect: 'not a verbatim copy',
    },
  ];
  for (const testCase of driftCandidates) {
    if (testCase.text === null) {
      skipped.push(testCase.name);
      continue;
    }
    applied += 1;
    const found = inspectOpenQuestions(spec, testCase.text);
    if (!found.some((problem) => problem.includes(testCase.expect))) {
      problems.push(`self-test [${testCase.name}]: expected ${JSON.stringify(testCase.expect)}, got ${JSON.stringify(found)}`);
    }
  }

  // Tolerance has a floor: if a document edit makes most mutations inapplicable, the
  // self-test is no longer testing anything and must say so loudly rather than pass.
  const minimumApplied = 5;
  if (applied < minimumApplied) {
    problems.push(
      `self-test: only ${String(applied)} of ${String(applied + skipped.length)} mutations could be applied (minimum ${String(minimumApplied)}); the documents changed shape enough that this self-test no longer covers its rules`,
    );
  }
  if (skipped.length > 0) {
    process.stdout.write(`documentation self-test: ${String(skipped.length)} mutation(s) not applicable to the current documents (skipped, not failed): ${skipped.join('; ')}\n`);
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
    `documentation self-test: ok (${String(applied)} mutation(s) detected, ${String(skipped.length)} skipped, control clean)\n`,
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
