#!/usr/bin/env node
// What the published tarball must and must not contain (review v8 V8-9).
//
// `npm pack` shipped `python/__pycache__/ipynb_sidecar.cpython-310.pyc` — a compiled
// copy of the sidecar whose header mtime/size matched the source exactly, so
// CPython's vintage check would have preferred it. Nothing guarded the package
// contents at all: `files` said `"python"`, which includes whatever happens to be in
// that directory.
//
// This asserts the SHAPE of the artifact rather than a file count, so adding a source
// file does not fail it and losing the sidecar does.
//
// Deliberately NOT asserted: source maps. `lib/*.map` ships, and that is ordinary for
// an npm package — listing it as a defect would have made this check fail on a clean
// tree, which is how a guard gets weakened to nothing. The first version of this file
// did exactly that, and also required an executable bit on `lib/bin.js`, which npm
// sets for `bin` entries regardless of the packed mode.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
const [pack] = JSON.parse(raw);
const files = pack.files.map((entry) => entry.path.replace(/\\/g, '/'));
const problems = [];

/** Things that must never ship. */
const FORBIDDEN = [
  [/\.pyc$/, 'compiled Python bytecode (CPython may prefer it over the source)'],
  [/__pycache__/, 'a Python cache directory'],
  [/\.pyo$/, 'compiled Python bytecode'],
  [/^src\//, 'TypeScript sources'],
  [/^tests\//, 'the test suite'],
  [/^docs\//, 'internal documentation'],
  [/^(probe|patch)-/, 'a scratch probe/patch script'],
  [/^scripts\//, 'repository scripts'],
  [/^\.github\//, "this project's CI configuration"],
];
for (const [pattern, why] of FORBIDDEN) {
  const hits = files.filter((file) => pattern.test(file));
  if (hits.length > 0) {
    problems.push(`ships ${why}: ${hits.slice(0, 5).join(', ')}`);
  }
}

/** Things that MUST ship, or the package does not work. */
const REQUIRED = [
  'lib/bin.js',
  'lib/server.js',
  'python/ipynb_sidecar.py',
  'README.md',
  'LICENSE',
  'package.json',
];
for (const required of REQUIRED) {
  if (!files.includes(required)) {
    problems.push(`does not ship ${required}`);
  }
}

// The entry point must keep its shebang: `npx ipynb-mcp` executes the file, and
// without `#!` the kernel cannot run it.
const binEntry = pack.files.find((entry) => entry.path.replace(/\\/g, '/') === 'lib/bin.js');
if (binEntry !== undefined && !/^#!\/usr\/bin\/env node/.test(binEntry.content ?? '')) {
  // Only meaningful when npm included the content (it does with --json on some
  // versions, not all), so a missing field is not treated as a failure.
  if (typeof binEntry.content === 'string') {
    problems.push('lib/bin.js does not start with the #!/usr/bin/env node shebang');
  }
}

// There must be exactly ONE sidecar: a stray copy is how the `.pyc` got in.
const pythonFiles = files.filter((file) => file.startsWith('python/'));
if (pythonFiles.length !== 1) {
  problems.push(`python/ should contain exactly the sidecar, found: ${pythonFiles.join(', ')}`);
}

// The tarball check above cannot FAIL on a bytecode file any more, because
// `files: ["python/*.py"]` excludes the directory that would hold one — so this
// second check guards the repo side, where the file actually appears: a
// `__pycache__` in `python/` means some tooling compiled the sidecar in place, and
// the next person to change `files` back to `"python"` would ship it. This is the
// assertion that can be made to fail on demand (delete it and drop a `.pyc` in).
const sidecarDir = path.join(REPO_ROOT, 'python');
const stray = readdirSync(sidecarDir).filter((entry) => entry !== 'ipynb_sidecar.py');
if (stray.length > 0) {
  problems.push(
    `python/ contains files the package must not carry: ${stray.join(', ')} ` +
      '(a __pycache__ here is what shipped a .pyc in v8; remove it and check the .gitignore)',
  );
}

if (problems.length > 0) {
  process.stderr.write(
    `package contents check failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(`package contents check: ok (${files.length} files)\n`);
