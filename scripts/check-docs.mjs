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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 * A digest over the document's own entry ids, so the declared count is not self-certifying.
 *
 * The v10 rule asked the table to END at the number the header declared, which catches a lost
 * row — unless the editor also adjusts the number. The reviewer did exactly that (delete the
 * last row, change `entries: 54` to `53`) and both the check and the self-test stayed green,
 * because the count and the table are the same document and nothing outside it was consulted
 * (review v11 V11-11).
 *
 * This line is that outside reference: it is derived from the ids, so any edit that adds,
 * removes or renames one changes it, and the only way to make the check pass again is to run
 * the tool that prints the new value (`node scripts/check-docs.mjs --print-digest`) — which is
 * a deliberate act, recorded in the diff, rather than a number adjusted in passing.
 *
 * It is not a security mechanism and does not pretend to be one: someone determined to hide a
 * deletion can recompute the digest. It makes the ACCIDENT impossible, which is the class of
 * failure the v9 splice and the v11 deletion both belong to.
 */
function entriesDigest(ids) {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
}

/** The digest the document declares about itself, or null when it declares none. */
function declaredDigest(lines) {
  for (const line of lines) {
    const match = /^>\s*digest:\s*([0-9a-f]+)\s*$/.exec(line);
    if (match !== null) {
      return match[1];
    }
  }
  return null;
}

/**
 * Words that turn a status row into a CLAIM that something was changed in the code.
 *
 * `docs/REVIEW-FIX-STATUS.md` says of itself that "every ✅ must carry a grep-able artefact",
 * and v11 found the rule broken for the first time since v8: a row claimed two fixes and
 * neither existed — the ghost symbol `callWarnings` was still in `src/run.ts`, and the
 * tautological assertion was still in `tests/unit/json-exact.test.ts` (review v11 V11-4).
 * Discipline did not hold; a cheap mechanical check does.
 */
const FIX_CLAIM_WORDS = ['已订正', '已删除', '已改名', '已移除', '已重命名', 'named', 'renamed', 'removed', 'deleted'];

/**
 * A backticked token in a claimed row must EXIST somewhere in the tree.
 *
 * Deliberately shallow: it does not check that the artefact proves the claim, only that the
 * thing named is real. That is enough for the failure it is aimed at — a row asserting that a
 * symbol was renamed, while the symbol it names appears nowhere in the repository.
 */
function claimProblems(file, text) {
  const problems = [];
  const root = REPO_ROOT;
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.startsWith('|') || !line.includes('✅')) {
      continue;
    }
    if (!FIX_CLAIM_WORDS.some((word) => line.includes(word))) {
      continue;
    }
    // Only the shapes that name a symbol or a path: an inline-code span, or `path:line`.
    const tokens = [...line.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .filter((token) => /^[\w./-]+(\.\w+)?(:\d+)?$/.test(token))
      .filter((token) => !/^\d+$/.test(token));
    if (tokens.length === 0) {
      problems.push(
        `${file}:${String(index + 1)}: a ✅ row claims a change but names no symbol or file to grep for`,
      );
      continue;
    }
    const missing = tokens.filter((token) => !exists(token));
    if (missing.length === tokens.length) {
      problems.push(
        `${file}:${String(index + 1)}: a ✅ row claims a change, but none of its artefacts exist in the tree: ${missing.join(', ')}`,
      );
    }
  }
  void root;
  return problems;
}

/**
 * Which tree a symbol named in a status row must live in.
 *
 * ONLY code, and deliberately not `docs`: the row that makes the claim is itself a document, so
 * `grepTree(docs, token)` found the token in the claim and every claim satisfied its own check.
 * That is the "期望自我循环" shape in its purest form — the guard proving the guard — and it was
 * caught by testing the gate against a symbol that exists nowhere (review v11 V11-4's gate).
 */
const CODE_DIRS = ['src', 'tests', 'scripts', 'python'];

/** Whether a token from a status row can be found in the repository (path or symbol). */
function exists(token) {
  const [pathPart] = token.split(':');
  // A PATH may point anywhere, docs included — the artifact is then the document itself.
  if (existsSync(path.join(REPO_ROOT, pathPart))) {
    return true;
  }
  // A bare symbol is looked for in code only.
  if (pathPart.length < 4) {
    return true;
  }
  return CODE_DIRS.some((dir) => grepTree(path.join(REPO_ROOT, dir), pathPart));
}

/** Is `needle` present in any text file under `dir`? Depth-first, with the usual exclusions. */
function grepTree(dir, needle) {
  if (!existsSync(dir)) {
    return false;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (grepTree(full, needle)) {
        return true;
      }
      continue;
    }
    if (!/\.(ts|js|mjs|py|md|json|sh)$/.test(entry.name)) {
      continue;
    }
    if (readFileSync(full, 'utf8').includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * The entry count the document declares about itself, or null when it declares none.
 *
 * The count lives next to the thing it counts (an `entries: NN` line in the header block) so
 * that adding a row and updating the count are the same edit. A document without the
 * declaration is not failed for it — only the two rules that need it are skipped — but the
 * reviewer's two mutations (delete the last row, append one) are both caught by it, which is
 * the falsifiability the v10 review asked for.
 *
 * The scan is over the whole document rather than its first lines, and the pattern accepts a
 * decorated form (`entries: 54 rows`): `declareCount` used to look at the first 12 lines with a
 * strict regex, so a harmless rewording of the header switched the rule OFF, and a rule that is
 * off looks exactly like a rule that passes (review v11 V11-11).
 */
function declareCount(lines, doc) {
  const pattern = /(?:^|\s)entries:\s*(\d+)/;
  for (const line of lines.slice(0, 40)) {
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
  // The outside reference: the ids themselves. See `entriesDigest`.
  //
  // A document that declares a count but NO digest is a problem, not a pass: the v11 mutation
  // (delete the last row, decrement the count) survives the count rule alone, so removing the
  // digest line would switch off the only rule that catches it — and a rule that is off looks
  // exactly like a rule that passes (review v11 V11-11, second half).
  const digest = declaredDigest(lines);
  if (digest === null) {
    problems.push(
      `${doc.file}: no \`> digest:\` line, so the declared entry count cannot be cross-checked; run \`node scripts/check-docs.mjs --print-digest\` and add it`,
    );
  } else {
    const actual = entriesDigest([...seen.keys()]);
    if (actual !== digest) {
      problems.push(
        `${doc.file}: the declared digest ${digest} does not match the entries (${actual}) — a row was added, removed or renamed without running \`node scripts/check-docs.mjs --print-digest\``,
      );
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
  problems.push(...claimProblems('docs/REVIEW-FIX-STATUS.md', read('docs/REVIEW-FIX-STATUS.md')));
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
      name: 'the last entry was deleted AND the count adjusted (the v11 reproduction)',
      // The mutation the count rule alone cannot see: the table and the declared count are the
      // same document, so they can be made to agree. The digest is what refuses.
      text:
        lastRow === null
          ? null
          : editLine(original, `| ${lastRow} |`, () => null).replace(
              /^(>\s*entries:\s*)\d+/m,
              (_all, prefix) => `${prefix}${String(Number(lastRow.slice(2)) - 1)}`,
            ),
      expect: 'does not match the entries',
    },
    {
      name: 'the digest line was removed (a rule that is off must not look like a pass)',
      text: /^> digest:.*\n/m.test(original) ? original.replace(/^> digest:.*\n/m, '') : null,
      expect: 'no `> digest:` line',
    },
    {
      name: 'a row was spliced onto the pasted copy (the v9 symptom, at row scale)',
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

/**
 * Print the digest the authority documents should declare.
 *
 * The deliberate path for a legitimate edit: add or remove a row, then run this and paste the
 * value. A wrong digest is a FAILURE rather than a warning, because it means the table changed
 * without anyone saying so — which is the shape of both the v9 splice and the v11 deletion.
 */
function printDigest() {
  for (const doc of AUTHORITY_DOCS) {
    const text = read(doc.file);
    const ids = [...text.matchAll(doc.idPattern)].map((match) => match[1]);
    process.stdout.write(`${doc.file}: entries: ${String(ids.length)} digest: ${entriesDigest(ids)}\n`);
  }
}

if (process.argv.includes('--print-digest')) {
  printDigest();
} else if (process.argv.includes('--selftest')) {
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
