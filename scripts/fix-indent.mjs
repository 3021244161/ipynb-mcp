import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// Fix block indentation BY AST, using exactly the rule the checker enforces:
// a block's statements sit at (opening line's indentation + 2), and the closing
// brace at either the opening line's indentation or the owning construct's
// column. Running this and the checker against each other until they agree is
// what keeps the two from drifting.
//
// Usage: node fix-indent.mjs <file.ts> [<file.ts> ...]

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error('usage: node fix-indent.mjs <file.ts> [...]');
}

function indent(text, line) {
  return /^[ \t]*/.exec(text.split('\n')[line] ?? '')[0].length;
}

function fixFile(file) {
  let text = readFileSync(file, 'utf8');
  let applied = 0;

  for (let round = 0; round < 25; round += 1) {
    const lines = text.split('\n');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const at = (p) => source.getLineAndCharacterOfPosition(p);
    const fixes = [];

    const fixLine = (line, target) => {
      const current = /^[ \t]*/.exec(lines[line] ?? '')[0].length;
      if (current === target) {
        return false;
      }
      lines[line] = ' '.repeat(target) + lines[line].slice(current);
      return true;
    };

    const handleBlock = (block, ownerColumn) => {
      if (block === undefined || block === null || !ts.isBlock(block)) {
        return;
      }
      const open = at(block.getStart(source, true));
      const close = at(block.end - 1);
      if (open.line === close.line) {
        return;
      }
      const own = indent(text, open.line);
      for (const statement of block.statements) {
        const where = at(statement.getStart(source, true));
        // Only touch a line whose first non-space character is this statement:
        // a statement sharing a line with other syntax cannot be re-indented
        // without rewriting the line.
        if (where.character === /^[ \t]*/.exec(lines[where.line])[0].length) {
          if (fixLine(where.line, own + 2)) {
            fixes.push(where.line + 1);
          }
        }
      }
      const closeIndent = indent(text, close.line);
      const accepted = new Set([own]);
      if (ownerColumn !== undefined) {
        accepted.add(ownerColumn);
      }
      if (!accepted.has(closeIndent) && close.character === closeIndent) {
        if (fixLine(close.line, own)) {
          fixes.push(close.line + 1);
        }
      }
    };

    const walk = (node) => {
      const owner = at(node.getStart(source, true)).character;
      if (ts.isTryStatement(node)) {
        handleBlock(node.tryBlock, owner);
        handleBlock(node.catchClause?.block, owner);
        handleBlock(node.finallyBlock, owner);
      } else if (ts.isIfStatement(node)) {
        handleBlock(node.thenStatement, owner);
        if (node.elseStatement !== undefined && !ts.isIfStatement(node.elseStatement)) {
          handleBlock(node.elseStatement, owner);
        }
      } else if (
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      ) {
        handleBlock(node.statement, owner);
      } else if (ts.isSwitchStatement(node)) {
        const caseColumn = indent(text, at(node.caseBlock.getStart(source, true)).line) + 2;
        for (const clause of node.caseBlock.clauses) {
          const where = at(clause.getStart(source, true));
          if (fixLine(where.line, caseColumn)) {
            fixes.push(where.line + 1);
          }
          for (const statement of clause.statements) {
            if (ts.isBlock(statement)) {
              handleBlock(statement, caseColumn);
            } else {
              const at2 = at(statement.getStart(source, true));
              if (fixLine(at2.line, caseColumn + 2)) {
                fixes.push(at2.line + 1);
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
        handleBlock(node.body, owner);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);

    if (fixes.length === 0) {
      break;
    }
    applied += fixes.length;
    text = lines.join('\n');
  }

  writeFileSync(file, text);
  console.log(`${file}: ${applied} lines re-indented`);
}

for (const file of files) {
  fixFile(file);
}
