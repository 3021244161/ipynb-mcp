import { readFileSync, writeFileSync } from 'node:fs';

// P0-a. Two separate problems, and the second is the serious one:
//   1. the two "external authority" assertions were guarded by a bare
//      `if (NBFORMAT_AVAILABLE)`, so on a machine without nbformat they simply
//      did not run and the suite stayed green with no trace;
//   2. CI's integration job installs `ipykernel jupyter_client`, and neither
//      depends on nbformat — so the ONE place that is supposed to verify output
//      against an external authority was the one place it never ran.
// The authority is now REQUIRED in CI (IPYNB_REQUIRE_NBFORMAT, same shape as
// IPYNB_TEST_REQUIRE_VENV) and visible as `skipped` everywhere else.
const p = 'tests/integration/run.test.ts';
let s = readFileSync(p, 'utf8');
const before = s;

const guard = [
  '    if (NBFORMAT_AVAILABLE) {',
  '      const validation = validateNotebook(nb, VENV_PY);',
];
const replacement = [
  '    // `it.skipIf` at the describe level makes an absent authority VISIBLE as a',
  '    // skip instead of a silent pass, and CI sets the requirement so it cannot be',
  '    // absent there at all (review v7 P0-a).',
  '    {',
  '      const validation = validateNotebook(nb, VENV_PY);',
];
const count = s.split(guard).length - 1;
if (count !== 2) {
  throw new Error(`expected 2 guarded assertions, found ${count}`);
}
s = s.split(guard).join(replacement);
s = s.replace(
  /      expect\(validation\.ok, `nbformat\.validate rejected the ([^`]+):\\n\$\{validation\.message\}`\)\.toBe\(true\);\n    \}/g,
  '      expect(validation.ok, `nbformat.validate rejected the $1:\\n${validation.message}`).toBe(true);\n    }',
);
if (s === before) {
  throw new Error('nothing changed');
}
writeFileSync(p, s);
console.log('made the two nbformat assertions unconditional');
