#!/usr/bin/env node
// Structural indentation check (review v4 QUAL-1).
//
// The same accident shipped three times: a whole `try` body one level shallower
// than its closing brace. It is invisible to `oxlint`, invisible to
// `git diff -w`, and it makes a statement look like it belongs to an enclosing
// block. v3's "fix" was a manual re-indent of a different range, and the review
// found the residue with a parser — which is the lesson: format checks must
// parse, not sample.
//
// So this parses. For every braced construct it asserts two things the eye
// cannot be trusted with:
//   1. every direct statement of a body starts at the same column;
//   2. a closing brace sits at the column of the line that opened the construct.
// It deliberately does NOT re-format or check continuation lines, object
// literals or ternaries: those legitimately vary, and a check that has to be
// suppressed protects nothing.
//
// No dependency: the repository already ships the TypeScript compiler for
// `pnpm typecheck`, so its parser is not a new cost.
//
// Usage: node scripts/check-indent.mjs [paths...]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ['src', 'tests'];

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

/** Column of a 1-based line/character offset pair. */
function columnOf(source, position) {
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  return { line, column: character };
}

function indentOf(text, line) {
  const match = /^[ \t]*/.exec(text);
  return match === null ? 0 : match[0].length;
}

const problems = [];

function checkBody(source, text, statements, bodyIndent, context) {
  for (const statement of statements) {
    const start = statement.getStart(source);
    const at = columnOf(source, start);
    const indent = indentOf(text.split('\n')[at.line], at.line);
    if (indent !== bodyIndent) {
      problems.push(
        `${context}: ${ts.SyntaxKind[statement.kind]} at line ${at.line + 1} is indented ${indent}, ` +
          `expected ${bodyIndent} (its block starts there)`,
      );
    }
  }
}

function checkBlock(source, text, node, openerColumn, context) {
  if (node === undefined || node === null) {
    return;
  }
  const statements = ts.isBlock(node) ? node.statements : [node];
  checkBody(source, text, statements, openerColumn + 2, context);
  if (ts.isBlock(node)) {
    const closeAt = columnOf(source, node.end - 1);
    const closeIndent = indentOf(text.split('\n')[closeAt.line], closeAt.line);
    if (closeIndent !== openerColumn) {
      problems.push(
        `${context}: closing brace at line ${closeAt.line + 1} is indented ${closeIndent}, ` +
          `expected ${openerColumn}`,
      );
    }
  }
}

function walk(source, text, node, context) {
  const openerColumn = columnOf(source, node.getStart(source)).column;

  if (ts.isTryStatement(node)) {
    checkBlock(source, text, node.tryBlock, openerColumn, `${context} try`);
    if (node.catchClause !== undefined) {
      // `} catch {` shares the try's column.
      const catchAt = columnOf(source, node.catchClause.getStart(source));
      const catchIndent = indentOf(text.split('\n')[catchAt.line], catchAt.line);
      if (catchIndent !== openerColumn) {
        problems.push(
          `${context}: catch at line ${catchAt.line + 1} is indented ${catchIndent}, expected ${openerColumn}`,
        );
      }
      checkBlock(source, text, node.catchClause.block, openerColumn, `${context} catch`);
    }
    if (node.finallyBlock !== undefined) {
      const finallyAt = columnOf(source, node.finallyBlock.getStart(source));
      const finallyIndent = indentOf(text.split('\n')[finallyAt.line], finallyAt.line);
      if (finallyIndent !== openerColumn) {
        problems.push(
          `${context}: finally at line ${finallyAt.line + 1} is indented ${finallyIndent}, expected ${openerColumn}`,
        );
      }
      checkBlock(source, text, node.finallyBlock, openerColumn, `${context} finally`);
    }
  } else if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    checkBlock(source, text, node.statement, openerColumn, `${context} ${ts.SyntaxKind[node.kind]}`);
  } else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    if (node.body !== undefined) {
      checkBlock(source, text, node.body, openerColumn, `${context} function body`);
    }
  }

  ts.forEachChild(node, (child) => {
    walk(source, text, child, context);
  });
}

for (const file of targets.flatMap((target) => collect(target))) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const relative = path.relative(process.cwd(), file);
  checkBody(source, text, source.statements, 0, `${relative} (top level)`);
  walk(source, text, source, relative);
}

if (problems.length > 0) {
  process.stderr.write(`structural indent check failed (${problems.length}):\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('structural indent check: ok\n');
