#!/usr/bin/env node
// Structural indentation check (review v4 QUAL-1, v6 INDENT-HOLE).
//
// The same accident shipped three times: a whole block one level shallower than
// its closing brace. It is invisible to `oxlint`, invisible to `git diff -w`, and
// it makes a statement look like it belongs to an enclosing block. Format checks
// must PARSE, not sample.
//
// Invariant, for every braced construct: with the opening brace at column C,
// every direct statement of that block starts at C + 2 and the closing brace sits
// at C. C is read from the brace's own position, so the two styles this
// repository mixes are both handled:
//     if (x) {
//       body();
//     }
//     const server = createServer({
//       config,
//     });
// Scope: blocks (`try`/`catch`/`finally`, `if`/`else`, loops, `switch` clauses,
// function/method/arrow/accessor bodies). Object-literal members and continuation
// lines are deliberately NOT checked: they legitimately vary, and a check that has
// to be suppressed protects nothing.
//
// This file is plain .mjs and outside tsconfig, so `tsc` cannot catch a wrong AST
// property name here — which is exactly how the `if` coverage stayed dead for two
// rounds (`IfStatement` has `thenStatement`, not `statement`). The SELF-TEST below
// runs on every invocation and fails the check when a construct stops being
// detected. AGENTS §9 applied to a guard: a guard must prove it can fail.
//
// Usage: node scripts/check-indent.mjs [paths...]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// Source helpers

const lineCache = new Map();
function linesOf(text) {
  let lines = lineCache.get(text);
  if (lines === undefined) {
    lines = text.split('\n');
    lineCache.set(text, lines);
  }
  return lines;
}

/** 0-based { line, character } of an absolute offset. */
function at(source, position) {
  return source.getLineAndCharacterOfPosition(position);
}

/** Leading-whitespace width of a 0-based line. */
function indentAt(text, line) {
  const match = /^[ \t]*/.exec(linesOf(text)[line] ?? '');
  return match === null ? 0 : match[0].length;
}

/**
 * The column a block's statements are measured against: the INDENTATION of the
 * line that opens the block.
 *
 * Not the brace's character column (`function f() {` puts a brace at 39 whose
 * body belongs at 2) and not the owning statement's column (`validate({` starts
 * at 4 while its contents legitimately sit deeper). The opening line's
 * indentation is the one value that is correct for both styles this repository
 * mixes, and it is also what the closing brace must line up with.
 */
function blockColumn(source, text, block) {
  return indentAt(text, at(source, block.getStart(source, true)).line);
}

// ---------------------------------------------------------------------------
// Checking

const problems = [];

function report(context, line, actual, expected) {
  problems.push(`${context}: line ${line + 1} is indented ${actual}, expected ${expected}`);
}

/**
 * Whether this node's line begins with nothing but whitespace before it.
 *
 * A statement sharing a line with other syntax has no indentation of its own to
 * measure. `checkStatements` REPORTS that case (it once hid two collapsed lines);
 * the `switch` branches use this to SKIP it, because a legal `case 1: return 1;`
 * puts two constructs on one line and neither the label nor the statement can be
 * satisfied without rewriting the line. The fixer skips exactly the same nodes, so
 * the two tools cannot disagree (review v7 V7-3).
 */
function ownsLine(text, where) {
  return (linesOf(text)[where.line] ?? '').slice(0, where.character).trim() === '';
}

function checkStatements(source, text, statements, column, context) {
  for (const statement of statements) {
    const where = at(source, statement.getStart(source, true));
    const actual = indentAt(text, where.line);
    // The statement must be the FIRST thing on its line. A statement sharing a
    // line with its block header (`() => {  it('...', () => {`) has no
    // indentation to measure at all — and this is exactly how an earlier bulk
    // edit collapsed two lines into one and went unnoticed.
    if (!ownsLine(text, where)) {
      report(
        `${context} [${ts.SyntaxKind[statement.kind]} is not on its own line]`,
        where.line,
        actual,
        column,
      );
      continue;
    }
    if (actual !== column) {
      report(
        `${context} [${ts.SyntaxKind[statement.kind]}]`,
        where.line,
        actual,
        column,
      );
    }
  }
}

/** Checks one braced block (or a brace-less body such as `if (x) return;`). */
function checkBlock(source, text, block, context, ownerColumn) {
  if (block === undefined || block === null) {
    return;
  }
  if (!ts.isBlock(block)) {
    // An expression body (`(target) => statSync(target)`) has no block header and
    // therefore no interior indentation contract; its own position is already
    // covered by the enclosing statement check.
    return;
  }
  const open = at(source, block.getStart(source, true));
  // A block that begins and ends on one line (`() => server.close()`) has no
  // interior indentation to verify. Measuring it produced "expected 26" for an
  // arrow body sitting in the middle of its own line.
  const close = at(source, block.end - 1);
  if (open.line === close.line) {
    return;
  }
  // The body sits one level inside the block. Its column comes from the block
  // itself and never from the owner: this function can be reached twice for the
  // same block (once through `switch`, once through the generic walk), and a rule
  // that depended on the caller reported two different "expected" values for one
  // line.
  const own = blockColumn(source, text, block);
  const label = `${context} @${open.line + 1}`;
  checkStatements(source, text, block.statements, own + 2, label);
  // The closing brace may line up with the block's opening line OR with the
  // construct that owns it, which is the legitimate answer when the opening brace
  // landed on a continuation line (a wrapped `if` condition).
  const closeIndent = indentAt(text, close.line);
  const accepted = new Set([own]);
  if (ownerColumn !== undefined) {
    accepted.add(ownerColumn);
  }
  if (!accepted.has(closeIndent)) {
    report(`${label} [closing brace]`, close.line, closeIndent, own);
  }
}

function walk(source, text, node, context) {
  const owner = at(source, node.getStart(source, true)).character;
  if (ts.isTryStatement(node)) {
    checkBlock(source, text, node.tryBlock, `${context} try`, owner);
    checkBlock(source, text, node.catchClause?.block, `${context} catch`, owner);
    checkBlock(source, text, node.finallyBlock, `${context} finally`, owner);
  } else if (ts.isIfStatement(node)) {
    // `thenStatement`, not `statement`: the wrong property made this branch a
    // no-op and left `if` bodies unchecked (review v6 INDENT-HOLE).
    checkBlock(source, text, node.thenStatement, `${context} if`, owner);
    if (node.elseStatement !== undefined && !ts.isIfStatement(node.elseStatement)) {
      checkBlock(source, text, node.elseStatement, `${context} else`, owner);
    }
  } else if (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    checkBlock(source, text, node.statement, `${context} ${ts.SyntaxKind[node.kind]}`, owner);
  } else if (ts.isSwitchStatement(node)) {
    const caseColumn = blockColumn(source, text, node.caseBlock) + 2;
    for (const clause of node.caseBlock.clauses) {
      const where = at(source, clause.getStart(source, true));
      // `case 1: return 1;` is legal TypeScript and puts the label and a statement
      // on ONE line. Neither can be judged by indentation — moving the line
      // satisfies one and breaks the other — so the label is skipped and each
      // statement is skipped by `checkStatements` below. Reporting it here made
      // the checker and the fixer contradict each other (review v7 V7-3).
      if (ownsLine(text, where)) {
        const actual = indentAt(text, where.line);
        if (actual !== caseColumn) {
          report(`${context} switch case`, where.line, actual, caseColumn);
        }
      }
      // A clause body is EITHER a `{ … }` block (whose own rule is its opening
      // line's indentation, so recursing checks it properly) or a list of
      // statements that sit exactly one level inside the `case`.
      for (const statement of clause.statements) {
        if (ts.isBlock(statement)) {
          checkBlock(source, text, statement, `${context} switch case`, owner);
        } else {
          const at2 = at(source, statement.getStart(source, true));
          if (!ownsLine(text, at2)) {
            continue;
          }
          const actual2 = indentAt(text, at2.line);
          if (actual2 !== caseColumn + 2) {
            report(
              `${context} switch case body [${ts.SyntaxKind[statement.kind]}]`,
              at2.line,
              actual2,
              caseColumn + 2,
            );
          }
        }
      }
    }
  } else if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    // Arrow and function expressions were never checked either.
    checkBlock(source, text, node.body, `${context} function body`, owner);
  }

  ts.forEachChild(node, (child) => {
    walk(source, text, child, context);
  });
}

/** Runs both checks over one snippet and returns what THIS call found. */
function analyse(name, text) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const before = problems.length;
  checkStatements(source, text, source.statements, 0, `${name} top level`);
  walk(source, text, source, name);
  // Slice by difference and then drop the tail: `splice` on the shared array
  // returned the wrong window once real findings were already present.
  const found = problems.slice(before);
  problems.length = before;
  return found;
}

// ---------------------------------------------------------------------------
// Self-test: every snippet is mis-indented in exactly one construct, and the
// clean sample must produce nothing.

const SELF_TEST_CASES = [
  ['if body', 'function f(a: number) {\n  if (a) {\n  return 1;\n  }\n}\n'],
  ['else body', 'function f(a: number) {\n  if (a) {\n    return 1;\n  } else {\n  return 2;\n  }\n}\n'],
  ['for body', 'function f(a: number) {\n  for (let i = 0; i < a; i += 1) {\n  use(i);\n  }\n}\n'],
  ['for-of body', 'function f(a: number[]) {\n  for (const x of a) {\n  use(x);\n  }\n}\n'],
  ['while body', 'function f(a: number) {\n  while (a) {\n  a -= 1;\n  }\n}\n'],
  ['switch case body', 'function f(a: number) {\n  switch (a) {\n    case 1:\n    return 1;\n  }\n}\n'],
  ['switch case label', 'function f(a: number) {\n  switch (a) {\n  case 1:\n    return 1;\n  }\n}\n'],
  ['try body', 'function f() {\n  try {\n  g();\n  } catch {\n    h();\n  }\n}\n'],
  ['catch body', 'function f() {\n  try {\n    g();\n  } catch {\n  h();\n  }\n}\n'],
  ['arrow body', 'const f = (a: number) => {\n  return a;\n  };\n'],
  ['function expression body', 'const f = function (a: number) {\n  return a;\n  };\n'],
  ['closing brace', 'function f(a: number) {\n  if (a) {\n    return 1;\n    }\n}\n'],
];

const CLEAN_SAMPLE = [
  'const logger = createLogger();',
  '',
  'export function f(a: number): number {',
  '  if (a > 0) {',
  '    return a;',
  '  } else if (a < 0) {',
  '    return -a;',
  '  } else {',
  '    return 0;',
  '  }',
  '}',
  '',
  'for (const item of [1, 2]) {',
  '  switch (item) {',
  '    case 1:',
  '      use(item);',
  '      break;',
  '    default:',
  '      break;',
  '  }',
  '}',
  '',
  'try {',
  '  risky();',
  '} catch {',
  '  recover();',
  '} finally {',
  '  done();',
  '}',
  '',
  // A legal `case` sharing its line with a statement. This must produce NOTHING:
  // reporting it made the checker contradict the fixer, and the two of them
  // rewrote the file for 25 rounds until it failed `pnpm lint` (review v7 V7-3).
  // It is in the CLEAN sample rather than a mis-indented one because the correct
  // verdict is "no problem", and a self-test that only checks detection cannot
  // catch a false positive.
  'switch (kind) {',
  '  case 1: return 1;',
  "  case 2: {",
  '    return 2;',
  '  }',
  '  default:',
  '    return 0;',
  '}',
  '',
].join('\n');

const undetected = SELF_TEST_CASES.filter(([name, snippet]) => analyse(`selftest-${name}.ts`, snippet).length === 0).map(
  ([name]) => name,
);
if (undetected.length > 0) {
  problems.push(
    `self-test: mis-indentation is NOT detected in: ${undetected.join(', ')} — ` +
      'the AST property for that construct is probably wrong (review v6 INDENT-HOLE)',
  );
}
const cleanFindings = analyse('selftest-clean.ts', CLEAN_SAMPLE);
if (cleanFindings.length > 0) {
  problems.push(`self-test: the checker reports a clean sample — ${cleanFindings[0]}`);
}

// ---------------------------------------------------------------------------
// The real run

function collect(target, out = []) {
  const info = statSync(target, { throwIfNoEntry: false });
  if (info === undefined) {
    return out;
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(target).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.')) {
        continue;
      }
      collect(path.join(target, entry), out);
    }
    return out;
  }
  if (/\.(ts|mts)$/.test(target)) {
    out.push(target);
  }
  return out;
}

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ['src', 'tests'];
for (const file of targets.flatMap((target) => collect(target))) {
  problems.push(...analyse(path.relative(process.cwd(), file), readFileSync(file, 'utf8')));
}

if (problems.length > 0) {
  process.stderr.write(`structural indent check failed (${problems.length}):\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('structural indent check: ok\n');
