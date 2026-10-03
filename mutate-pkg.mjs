import { readFileSync, writeFileSync } from 'node:fs';

// V8-9 mutation check: if a `.pyc` reappears (or the sidecar goes missing), the new
// package check must fail. Without this the check is another guard that cannot fail.
const p = 'scripts/check-package.mjs';
const original = readFileSync(p, 'utf8');

// Mutate the CHECK to make the forbidden pattern unmatchable, which is equivalent to
// a `.pyc` being present and unnoticed.
const from = '  [/\\.pyc$/, \'compiled Python bytecode (CPython may prefer it over the source)\'],';
const to = '  [/\\.pycc$/, \'compiled Python bytecode\'],';
if (!original.includes(from)) {
  throw new Error('the .pyc rule was not found');
}
writeFileSync(p, original.replace(from, to));
console.log('mutated: the .pyc rule can no longer match');
