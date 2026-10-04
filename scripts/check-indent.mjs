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
// Self-test. Two matrices, because detection and false-positive resistance fail in
// opposite directions and no single sample can prove both:
//
//   DETECTION_CASES  one construct per sample, mis-indented. `expect` is a substring
//                    that must appear in at least one finding. Naming the expected
//                    message is the point: for a statement that shares its line with
//                    other syntax, "reported the wrong thing" and "reported nothing"
//                    are different failures and "something was found" cannot tell
//                    them apart (review v9 V8-17 — forcing the `ownsLine` guard true
//                    left the whole script green).
//   CLEAN_CASES      must produce NOTHING. These are what make a guard's SKIP branches
//                    falsifiable: each sample starts reporting the moment the guard
//                    that skips it stops skipping.
//
// Each sample carries `proves` — the mutation that turns it red — because AGENTS §9
// asks a guard to name it, and a sample nobody can attribute is a sample whose loss of
// power nobody notices. This matrix exists at all because the file is plain .mjs
// outside tsconfig, so `tsc` cannot see a wrong AST property name here: that is how the
// `if` coverage stayed dead for two rounds (`IfStatement` has `thenStatement`, not
// `statement`, review v6 INDENT-HOLE).

const DETECTION_CASES = [
  {
    name: 'if-body',
    proves: '`thenStatement` carries the if body; `statement` would cover nothing',
    expect: 'if @2 [ReturnStatement]',
    snippet: 'function f(a: number) {\n  if (a) {\n  return 1;\n  }\n}\n',
  },
  {
    name: 'else-body',
    proves: 'the `else` clause is checked separately from the `then` clause',
    expect: 'else @4 [ReturnStatement]',
    snippet: 'function f(a: number) {\n  if (a) {\n    return 1;\n  } else {\n  return 2;\n  }\n}\n',
  },
  {
    name: 'for-body',
    proves: '`ForStatement` is in the loop disjunction',
    expect: 'ForStatement @2 [ExpressionStatement]',
    snippet: 'function f(a: number) {\n  for (let i = 0; i < a; i += 1) {\n  use(i);\n  }\n}\n',
  },
  {
    name: 'for-of-body',
    proves: '`ForOfStatement` is in the loop disjunction',
    expect: 'ForOfStatement @2 [ExpressionStatement]',
    snippet: 'function f(a: number[]) {\n  for (const x of a) {\n  use(x);\n  }\n}\n',
  },
  {
    name: 'for-in-body',
    proves: '`ForInStatement` is in the loop disjunction',
    expect: 'ForInStatement @2 [ExpressionStatement]',
    snippet: 'function f(a: Record<string, number>) {\n  for (const k in a) {\n  use(k);\n  }\n}\n',
  },
  {
    name: 'while-body',
    proves: '`WhileStatement` is in the loop disjunction',
    expect: 'WhileStatement @2 [ExpressionStatement]',
    snippet: 'function f(a: number) {\n  while (a) {\n  a -= 1;\n  }\n}\n',
  },
  {
    name: 'do-body',
    proves: '`DoStatement` is in the loop disjunction',
    expect: 'DoStatement @2 [ExpressionStatement]',
    snippet: 'function f(a: number) {\n  do {\n  a -= 1;\n  } while (a > 0);\n}\n',
  },
  {
    name: 'switch-case-label',
    proves: 'a `case`/`default` label sits one level inside the case block',
    expect: 'switch case: line 3 is indented 2, expected 4',
    snippet: 'function f(a: number) {\n  switch (a) {\n  case 1:\n    return 1;\n  }\n}\n',
  },
  {
    name: 'switch-case-body',
    proves: 'a statement-list case body sits one level inside its label',
    expect: 'switch case body [ReturnStatement]',
    snippet: 'function f(a: number) {\n  switch (a) {\n    case 1:\n    return 1;\n  }\n}\n',
  },
  {
    name: 'switch-case-block',
    proves: 'a braced case body goes through `checkBlock` (its own rule), not the statement list',
    expect: 'switch case @3 [closing brace]',
    snippet: 'function f(a: number) {\n  switch (a) {\n    case 1: {\n      return 1;\n      }\n  }\n}\n',
  },
  {
    name: 'try-body',
    proves: '`tryBlock` is checked',
    expect: 'try @2 [ExpressionStatement]',
    snippet: 'function f() {\n  try {\n  g();\n  } catch {\n    h();\n  }\n}\n',
  },
  {
    name: 'catch-body',
    proves: '`catchClause.block` is checked',
    expect: 'catch @4 [ExpressionStatement]',
    snippet: 'function f() {\n  try {\n    g();\n  } catch {\n  h();\n  }\n}\n',
  },
  {
    name: 'finally-body',
    proves: '`finallyBlock` is checked',
    expect: 'finally @4 [ExpressionStatement]',
    snippet: 'function f() {\n  try {\n    g();\n  } finally {\n  h();\n  }\n}\n',
  },
  {
    name: 'function-declaration-body',
    proves:
      '`FunctionDeclaration` bodies are checked — the mis-indented statement is a DIRECT child of the body, so no inner block can report it instead',
    expect: 'function body @1 [IfStatement]',
    snippet: 'function f(a: number) {\n    if (a) {\n      return 1;\n    }\n}\n',
  },
  {
    name: 'arrow-body',
    proves: '`ArrowFunction` is in the function-body disjunction',
    expect: 'function body @1 [ReturnStatement]',
    snippet: 'const f = (a: number) => {\n    return a;\n};\n',
  },
  {
    name: 'arrow-closing-brace',
    proves:
      "the closing brace is measured against the line that opened the block, NOT against the owner's character column (this owner starts mid-line at column 10)",
    expect: 'function body @1 [closing brace]',
    snippet: 'const f = (a: number) => {\n  return a;\n  };\n',
  },
  {
    name: 'function-expression-body',
    proves: '`FunctionExpression` is in the function-body disjunction',
    expect: 'function body @1 [ReturnStatement]',
    snippet: 'const f = function (a: number) {\n    return a;\n};\n',
  },
  {
    name: 'method-body',
    proves: '`MethodDeclaration` is in the function-body disjunction',
    expect: 'function body @2 [ReturnStatement]',
    snippet: 'class C {\n  m(a: number) {\n  return a;\n  }\n}\n',
  },
  {
    name: 'constructor-body',
    proves: '`ConstructorDeclaration` is in the function-body disjunction',
    expect: 'function body @2 [ExpressionStatement]',
    snippet: 'class C {\n  constructor(a: number) {\n  use(a);\n  }\n}\n',
  },
  {
    name: 'get-accessor-body',
    proves: '`GetAccessorDeclaration` is in the function-body disjunction',
    expect: 'function body @2 [ReturnStatement]',
    snippet: 'class C {\n  get value(): number {\n  return 1;\n  }\n}\n',
  },
  {
    name: 'set-accessor-body',
    proves: '`SetAccessorDeclaration` is in the function-body disjunction',
    expect: 'function body @2 [ExpressionStatement]',
    snippet: 'class C {\n  set value(v: number) {\n  use(v);\n  }\n}\n',
  },
  {
    name: 'closing-brace',
    proves: 'a closing brace must line up with the line that opened the block',
    expect: 'if @2 [closing brace]',
    snippet: 'function f(a: number) {\n  if (a) {\n    return 1;\n    }\n}\n',
  },
  {
    name: 'statement-not-on-own-line',
    proves:
      'a statement glued to its block header is reported AS SUCH — force `ownsLine` true and only the generic indent message survives, which describes a different defect',
    expect: '[ExpressionStatement is not on its own line]',
    snippet: 'function f(a: number) {\n  if (a) { use(a);\n  }\n}\n',
  },
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

// The false-positive half. Each entry is an input a guard must NOT report on — most of
// them because a guard exists to skip exactly that shape — so a sample that starts
// reporting is the guard reporting instead of skipping.
const CLEAN_CASES = [
  {
    name: 'mixed-style',
    proves: 'the two brace styles this repository mixes, plus the legal `case 1: return 1;`',
    snippet: CLEAN_SAMPLE,
  },
  {
    name: 'switch-label-shares-line',
    proves:
      'the switch-label `ownsLine` guard in `walk`: force it true and this sample reports "switch case" on the `default:` that follows a statement',
    snippet:
      'function f(a: number) {\n' +
      '  switch (a) {\n' +
      '    case 1:\n' +
      '      break; default:\n' +
      '      break;\n' +
      '  }\n' +
      '}\n',
  },
  {
    name: 'one-line-blocks',
    proves:
      'the one-line-block early return: turn it off and the statement collapsed onto the header line is reported',
    snippet: 'function f(a: number) {\n  if (a) { use(a); }\n  try { g(); } catch { h(); }\n}\n',
  },
  {
    name: 'braceless-bodies',
    proves:
      'the non-block body early return: turn it off and `checkBlock` reads `.statements` off a plain statement and throws. The bodies that span lines are the ones that reach it — a single-line one is stopped earlier by the one-line rule, and nothing about the guard would be exercised.',
    snippet:
      'const g = (x: number) => x + 1;\n' +
      'function f(a: number) {\n' +
      '  if (a) return 1;\n' +
      '  else return g(a);\n' +
      '  for (let i = 0; i < a; i += 1)\n' +
      '    use(\n' +
      '      i,\n' +
      '    );\n' +
      '  while (a > 0) a -= 1;\n' +
      '  do a -= 1; while (a > 0);\n' +
      '  return 0;\n' +
      '}\n',
  },
  {
    name: 'wrapped-header-closing-brace',
    proves:
      'the `ownerColumn` acceptance: when the opening brace lands on a continuation line, the closing brace may line up with the construct that owns it instead',
    snippet: 'function f(\n  a: number\n  ) {\n    return a;\n}\n',
  },
];

const SAMPLE_COUNT = DETECTION_CASES.length + CLEAN_CASES.length;

/** Findings for one sample. A broken guard can make the checker throw where it used to
 * skip (a brace-less body has no `.statements`), and a stack trace names no sample — so
 * attribute the throw to the sample instead. */
function findingsFor(name, snippet) {
  try {
    return analyse(`selftest-${name}.ts`, snippet);
  } catch (error) {
    return [`threw ${error instanceof Error ? error.message : String(error)}`];
  }
}

if (SAMPLE_COUNT < 2 || DETECTION_CASES.length === 0 || CLEAN_CASES.length === 0) {
  // Otherwise an emptied matrix would pass by having nothing left to contradict.
  problems.push('self-test: the sample matrix is empty — the guard has nothing to prove itself with');
}

for (const { name, proves, expect, snippet } of DETECTION_CASES) {
  const found = findingsFor(name, snippet);
  if (!found.some((finding) => finding.includes(expect))) {
    const got = found.length === 0 ? 'no finding at all' : `instead "${found[0]}"`;
    problems.push(
      `self-test [${name}]: expected a finding containing "${expect}", got ${got} — ${proves} (review v9 V8-17)`,
    );
  }
}

for (const { name, proves, snippet } of CLEAN_CASES) {
  const found = findingsFor(name, snippet);
  if (found.length > 0) {
    problems.push(`self-test [${name}]: the checker reports a clean sample — ${found[0]} — ${proves}`);
  }
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
process.stdout.write(`structural indent check: ok (${SAMPLE_COUNT} self-test samples passed)\n`);
