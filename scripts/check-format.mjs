#!/usr/bin/env node
// Format guard (review v3 QUAL-1). The repository has no formatter, and two
// indentation defects shipped in f7bb82e because nothing could see them.
// `oxlint` has no formatting rules and adding prettier is a new dependency
// (AGENTS §11: ask a human first), so this checks the two properties that are
// both decidable and unambiguous:
//   1. no tab characters anywhere in indentation;
//   2. no trailing whitespace on a code line.
// It deliberately does NOT try to verify block nesting: continuation lines,
// object literals and ternaries all legitimately use deeper indentation, and a
// heuristic that flagged them would be worse than no check (it would have to be
// suppressed, and a suppressed check protects nothing).
//
// Usage: node scripts/check-format.mjs [paths...]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ['src', 'tests', 'scripts'];

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
  if (/\.(ts|mts|mjs)$/.test(target)) {
    out.push(target);
  }
  return out;
}

const problems = [];
for (const file of targets.flatMap((target) => collect(target))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indentation = /^[ \t]*/.exec(line)[0];
    if (indentation.includes('\t')) {
      problems.push(`${file}:${index + 1}: tab character in indentation`);
      continue;
    }
    if (line.trim() !== '' && /[ \t]+$/.test(line)) {
      problems.push(`${file}:${index + 1}: trailing whitespace`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`format check failed (${problems.length}):\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('format check: ok\n');
