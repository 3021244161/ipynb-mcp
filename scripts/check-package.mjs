#!/usr/bin/env node
// What the published tarball must and must not contain (review v8 V8-9, v9 V8-9).
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
// WHY `lib/` IS ASSERTED THROUGH THE BUILD OUTPUT AND NOT AS A HAND-WRITTEN LIST.
// `npm pack` runs `prepack` (`tsc`), which REBUILDS `lib/` before the manifest is taken,
// so deleting `lib/bin.js` cannot turn this script red — the build puts it back, and a
// `REQUIRED` entry naming it promised a check nobody could ever make fail that way
// (review v9 V8-9 residual). What CAN fail is `files` drifting off `lib/`: npm packs the
// `bin` target and README/LICENSE unconditionally, so the tarball would still carry
// `lib/bin.js` while the 32 modules it imports vanished — a published package that
// cannot start. So the modules are DERIVED from what the build emitted (`builtModules`)
// and each one must be in the manifest. Deleting a file under `lib/` stays green on
// purpose: producing that file is the build's job, verified by the type-checked build.
// Two further consequences of the same rebuild are handled below: the entry point is
// asserted through `package.json#bin` (the property the build cannot repair by itself),
// and its shebang is read from the BUILT file, because this npm emits only
// `{path,size,mode}` per manifest entry — so the earlier check against `entry.content`
// could never fire either.
//
// WHY ONLY THREE `REQUIRED` ENTRIES. npm packs `package.json`, README/LICENSE and the
// `bin` target unconditionally, whatever `files` says (measured, not assumed), so
// "must ship README.md" can only fail when the file itself is gone — which is exactly
// the mutation worth catching, and what makes these entries falsifiable. `package.json`
// is left out because no tarball can lack it, i.e. its entry could not fail.
//
// Falsifiability (AGENTS §9 — a guard must prove it can fail). Every family below is
// driven on every invocation by SELFTEST_MATRIX, which runs `inspect` against a
// synthetic manifest and exits non-zero when a mutation goes undetected:
//
//   | family                     | mutation that turns it red                                |
//   | -------------------------- | --------------------------------------------------------- |
//   | forbidden: bytecode        | ship `python/ipynb_sidecar.pyc` (and the legacy `.pyo`)    |
//   | forbidden: a cache dir     | ship `python/__pycache__/ipynb_sidecar.cpython-310.pyc`    |
//   | forbidden: sources/tests/… | ship `src/bin.ts` (one rule each for tests/, docs/, scripts/, .github/) |
//   | forbidden: scratch scripts | ship `mutate-pkg.mjs` at the tarball root                  |
//   | required                   | delete the sidecar / `README.md` / `LICENSE`               |
//   | built modules              | drop `lib` from `files` (npm still packs `bin`'s own file) |
//   | entry point (from `bin`)   | point `bin` at a path the build does not produce           |
//   | entry point shebang        | drop the `#!` line from `src/bin.ts`                       |
//   | exactly one sidecar        | add `python/helper.py`                                     |
//   | repo `python/` hygiene     | byte-compile the sidecar in place (`python/__pycache__`)   |
//
// `node scripts/check-package.mjs --selftest` runs the matrix alone, without invoking
// `npm pack`: the matrix is pure, so it still answers when the tree does not build.
//
// Deliberately NOT asserted: source maps. `lib/*.map` ships, and that is ordinary for
// an npm package — listing it as a defect would have made this check fail on a clean
// tree, which is how a guard gets weakened to nothing. The first version of this file
// did exactly that, and also required an executable bit on `lib/bin.js`, which npm
// sets for `bin` entries regardless of the packed mode.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELFTEST_ONLY = process.argv.includes('--selftest');
const SIDECAR_NAME = 'ipynb_sidecar.py';
const SIDECAR = `python/${SIDECAR_NAME}`;

/** npm reports Windows separators, and `bin` targets are written `./lib/bin.js`. */
function normalize(entry) {
  return entry.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Things that must never ship. */
const FORBIDDEN = [
  [/\.pyc$/, 'compiled Python bytecode (CPython may prefer it over the source)'],
  [/__pycache__/, 'a Python cache directory'],
  // Labeled apart from `.pyc` so the self-test can attribute a failure to one rule.
  [/\.pyo$/, 'compiled Python bytecode (legacy .pyo)'],
  [/^src\//, 'TypeScript sources'],
  [/^tests\//, 'the test suite'],
  [/^docs\//, 'internal documentation'],
  // One rule per scratch-script family, so a failure names the shape it found. They
  // are labeled separately because the self-test asserts which rule fired: a single
  // `/(probe|patch|mutate)-/` pattern would report `mutate-pkg.mjs` as "a scratch
  // probe/patch script", which is true but not what the file is (review v9 hygiene).
  [/^probe-/, 'a scratch probe script'],
  [/^patch-/, 'a scratch patch script'],
  [/^mutate-/, 'a scratch mutation script'],
  [/^scripts\//, 'repository scripts'],
  [/^\.github\//, "this project's CI configuration"],
  // A root-level script only gets in through an over-broad `files`, and the scratch
  // scripts still sitting in the working tree (`mutate-pkg.mjs`) are that shape.
  [/^[^/]+\.(?:js|mjs|cjs|ts)$/, 'a root-level script'],
];

/**
 * Entries no config names. Falsifiable by deleting the file, because npm cannot pack
 * a file that is not there.
 */
const REQUIRED = [SIDECAR, 'README.md', 'LICENSE'];

/**
 * Every file allowed to sit in the repository ROOT.
 *
 * Seven incidents of "a scratch file reached the repository" (patch-*, probe-*, mutate-*, commit-message
 * drafts, and v14's `tmp-result-backup.ts`, an outdated copy of a source file that no gate could see because
 * they all scope themselves to `src`/`tests`/`scripts`). Each one added a `.gitignore` pattern, which only
 * ever fixes the shape that already happened. A whitelist fixes the CLASS: the root is a small, stable set,
 * so anything unexpected there is either deliberate or leftover, and the difference is a one-line edit to
 * this list with a reason attached (v14 V14-4).
 */
const ROOT_ALLOWED = new Set([
  '.gitattributes',
  '.gitignore',
  '.oxlintrc.json',
  'AGENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'SPEC.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.test.json',
  'vitest.config.ts',
  'vitest.integration.config.ts',
]);

/**
 * The rules, as a pure function of what was observed, so the self-test can drive them
 * with a synthetic observation instead of a real tarball.
 *
 * `packaged`     normalized paths npm would put in the tarball
 * `binaries`     `{ path, head }` for every `package.json#bin` target; `head` is the
 *                first line of the built file, or undefined when it is not on disk
 * `builtModules` every compiled `.js` module under `lib/` in the working tree
 * `repoPython`   names inside `python/` in the working tree
 */
function inspect({ packaged, binaries, builtModules, repoPython, rootFiles = [] }) {
  const problems = [];

  // The root whitelist. Reported with the file names, because "which file" is the actionable part, and
  // scoped to TRACKED-ish observation: the caller passes what is on disk minus what git ignores.
  const strayRoot = rootFiles.filter((name) => !ROOT_ALLOWED.has(name));
  if (strayRoot.length > 0) {
    problems.push(
      `the repository root has files that are not in the whitelist: ${strayRoot.slice(0, 5).join(', ')} (a scratch file belongs in %TEMP%, a keeper belongs in scripts/ with a reason in ROOT_ALLOWED)`,
    );
  }

  for (const [pattern, why] of FORBIDDEN) {
    const hits = packaged.filter((file) => pattern.test(file));
    if (hits.length > 0) {
      problems.push(`ships ${why}: ${hits.slice(0, 5).join(', ')}`);
    }
  }

  for (const required of REQUIRED) {
    if (!packaged.includes(required)) {
      problems.push(`does not ship ${required}`);
    }
  }

  // The entry point `npx ipynb-mcp-server` runs. npm packs whatever `bin` names without
  // asking `files`, so the assertion that can fail is "the path `bin` names is one the
  // build actually produces": repoint `bin` at a path `tsc` does not emit and the
  // tarball silently loses its entry point.
  for (const { path: target, head } of binaries) {
    if (!packaged.includes(target)) {
      problems.push(`does not ship ${target}, the path package.json#bin points npm at`);
    }
    // An absent first line is not evidence of an absent shebang: `head` is only ever
    // undefined because the file is not on disk, which the check above already reports.
    if (head !== undefined && !head.startsWith('#!/usr/bin/env node')) {
      problems.push(`${target} does not start with the #!/usr/bin/env node shebang`);
    }
  }

  // Every module the build emitted must be published. Checking only the entry point
  // would miss the case that matters: npm packs `bin`'s file whatever `files` says, so
  // `files` drifting off `lib/` leaves `lib/bin.js` in the tarball while the modules it
  // imports are gone.
  const missingModules = builtModules.filter((module) => !packaged.includes(module));
  if (missingModules.length > 0) {
    const more =
      missingModules.length > 5 ? ` and ${missingModules.length - 5} more` : '';
    problems.push(
      `does not ship the built module(s) the package needs: ${missingModules.slice(0, 5).join(', ')}${more} ` +
        '— `files` no longer covers `lib/`',
    );
  }

  // There must be exactly ONE sidecar: a stray copy is how the `.pyc` got in.
  const pythonFiles = packaged.filter((file) => file.startsWith('python/'));
  if (pythonFiles.length !== 1) {
    problems.push(`python/ should contain exactly the sidecar, found: ${pythonFiles.join(', ')}`);
  }

  // The tarball check above cannot FAIL on a bytecode file any more, because
  // `files: ["python/*.py"]` excludes the directory that would hold one — so this
  // second check guards the repo side, where the file actually appears: a
  // `__pycache__` in `python/` means some tooling compiled the sidecar in place, and
  // the next person to change `files` back to `"python"` would ship it. This is the
  // assertion that can be made to fail on demand (delete it and drop a `.pyc` in).
  const stray = repoPython.filter((entry) => entry !== SIDECAR_NAME);
  if (!repoPython.includes(SIDECAR_NAME)) {
    problems.push(`python/${SIDECAR_NAME} is missing from the working tree`);
  }
  if (stray.length > 0) {
    problems.push(
      `python/ contains files the package must not carry: ${stray.join(', ')} ` +
        '(a __pycache__ here is what shipped a .pyc in v8; remove it and check the .gitignore)',
    );
  }

  return problems;
}


/**
 * Root-level entries that git would actually track.
 *
 * Ignored files are excluded on purpose: the root legitimately holds things like `lib/`, `node_modules/` and
 * a scratch `.txt` during a session, and failing on those would make this rule noise — which is how rules get
 * deleted (v10 V10-8: a guard must not fail for reasons unrelated to what it guards).
 */
function trackedRootEntries() {
  const listed = spawnSync('git', ['ls-files', '--others', '--cached', '--exclude-standard', '--directory'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (listed.status !== 0) {
    return [];
  }
  return [
    ...new Set(
      String(listed.stdout)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.includes('/')),
    ),
  ];
}

// ---------------------------------------------------------------------------
// The mutation matrix: every rule above, plus the mutation it must catch.

const CLEAN_MANIFEST = {
  packaged: ['LICENSE', 'README.md', 'package.json', 'lib/bin.js', 'lib/server.js', SIDECAR],
  binaries: [{ path: 'lib/bin.js', head: '#!/usr/bin/env node\n' }],
  builtModules: ['lib/bin.js', 'lib/server.js'],
  repoPython: [SIDECAR_NAME],
};
const shipped = (...extra) => [...CLEAN_MANIFEST.packaged, ...extra];
const dropped = (entry) => CLEAN_MANIFEST.packaged.filter((candidate) => candidate !== entry);

const SELFTEST_MATRIX = [
  // The control is not decoration: without it, a rule that fired on everything would
  // "detect" every mutation below.
  { mutation: 'control: a clean manifest', expect: null, observation: {} },
  {
    mutation: 'a scratch file in the repository root',
    expect: 'not in the whitelist',
    observation: { rootFiles: ['package.json', 'tmp-result-backup.ts'] },
  },
  {
    mutation: 'ship a .pyc next to the sidecar',
    expect: 'ships compiled Python bytecode',
    observation: { packaged: shipped('python/ipynb_sidecar.pyc') },
  },
  {
    mutation: 'ship a __pycache__ directory',
    expect: 'ships a Python cache directory',
    observation: { packaged: shipped('python/__pycache__/ipynb_sidecar.cpython-310.pyc') },
  },
  {
    mutation: 'ship TypeScript sources',
    expect: 'ships TypeScript sources',
    observation: { packaged: shipped('src/bin.ts') },
  },
  {
    mutation: 'ship the test suite',
    expect: 'ships the test suite',
    observation: { packaged: shipped('tests/unit/config.test.ts') },
  },
  {
    mutation: 'ship internal documentation',
    expect: 'ships internal documentation',
    observation: { packaged: shipped('docs/DEVIATIONS.md') },
  },
  {
    mutation: 'ship the repository scripts',
    expect: 'ships repository scripts',
    observation: { packaged: shipped('scripts/check-package.mjs') },
  },
  {
    mutation: 'ship a scratch probe script',
    expect: 'ships a scratch probe script',
    observation: { packaged: shipped('probe-tmp.mjs') },
  },
  {
    mutation: 'ship a scratch patch script',
    expect: 'ships a scratch patch script',
    observation: { packaged: shipped('patch-tmp.mjs') },
  },
  {
    // The rule this mutation exists for: `mutate-pkg.mjs` really was tracked in the
    // working tree for a round, and the failure has to name it as a mutation script
    // rather than letting the generic root-script rule take the credit.
    mutation: 'ship a scratch mutation script',
    expect: 'ships a scratch mutation script',
    observation: { packaged: shipped('mutate-pkg.mjs') },
  },
  {
    // A root-level file that is NOT a scratch script (a stray config, say) is caught
    // by the generic rule, so the two cannot mask each other.
    mutation: 'ship a root-level script that is not a scratch script',
    expect: 'ships a root-level script',
    observation: { packaged: shipped('stray-config.ts') },
  },
  {
    mutation: 'ship the CI configuration',
    expect: "ships this project's CI configuration",
    observation: { packaged: shipped('.github/workflows/ci.yml') },
  },
  {
    mutation: 'ship legacy .pyo bytecode',
    expect: 'ships compiled Python bytecode (legacy .pyo)',
    observation: { packaged: shipped('python/ipynb_sidecar.pyo') },
  },
  {
    mutation: 'lose the sidecar',
    expect: `does not ship ${SIDECAR}`,
    observation: { packaged: dropped(SIDECAR) },
  },
  {
    mutation: 'lose README.md from the working tree',
    expect: 'does not ship README.md',
    observation: { packaged: dropped('README.md') },
  },
  {
    mutation: 'lose LICENSE from the working tree',
    expect: 'does not ship LICENSE',
    observation: { packaged: dropped('LICENSE') },
  },
  {
    mutation: 'point package.json#bin at a path the build does not produce',
    expect: 'does not ship lib/bin.js, the path package.json#bin points npm at',
    observation: {
      packaged: dropped('lib/bin.js'),
      binaries: [{ path: 'lib/bin.js', head: undefined }],
    },
  },
  {
    mutation: 'let `files` drift off lib/ (npm still packs the bin file)',
    expect: 'does not ship the built module(s) the package needs: lib/server.js',
    observation: { packaged: dropped('lib/server.js') },
  },
  {
    mutation: 'lose the shebang in the built entry point',
    expect: 'lib/bin.js does not start with the #!/usr/bin/env node shebang',
    observation: { binaries: [{ path: 'lib/bin.js', head: '"use strict";\n' }] },
  },
  {
    mutation: 'the entry point has no readable first line (must stay silent)',
    expect: null,
    observation: { binaries: [{ path: 'lib/bin.js', head: undefined }] },
  },
  {
    mutation: 'add a second file to python/',
    expect: 'python/ should contain exactly the sidecar',
    observation: { packaged: shipped('python/helper.py') },
  },
  {
    mutation: 'byte-compile the sidecar in the working tree',
    expect: 'python/ contains files the package must not carry',
    observation: { repoPython: ['__pycache__', SIDECAR_NAME] },
  },
  {
    mutation: 'delete the sidecar from the working tree',
    expect: `python/${SIDECAR_NAME} is missing from the working tree`,
    observation: { repoPython: [] },
  },
];

/** Returns one line per mutation this run could NOT detect. */
function selftest() {
  const failures = [];
  for (const { mutation, expect, observation } of SELFTEST_MATRIX) {
    const problems = inspect({ ...CLEAN_MANIFEST, ...observation });
    const detected =
      expect === null ? problems.length === 0 : problems.some((problem) => problem.includes(expect));
    if (!detected) {
      const got = problems.length === 0 ? 'no problem at all' : `instead: ${problems[0]}`;
      failures.push(`self-test [${mutation}]: expected ${expect ?? 'no problem'}, got ${got}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// The real run

/** The first line of a built file, or undefined when the build produced nothing there. */
function firstLineOf(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0] : undefined;
}

/** Every compiled `.js` module under `lib/`, relative to the repo root. */
function readBuiltModules() {
  const root = path.join(REPO_ROOT, 'lib');
  if (!existsSync(root)) {
    return [];
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        found.push(normalize(path.relative(REPO_ROOT, full)));
      }
    }
  };
  walk(root);
  return found;
}

function readObservation() {
  let pack;
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    [pack] = JSON.parse(raw);
  } catch (error) {
    // `prepack` runs `tsc`, so a tree that does not build means the contents are
    // UNKNOWN. Say that instead of printing a stack trace — but still exit non-zero:
    // "could not check" must never read as "checked and fine".
    const stdout = error.stdout;
    const detail = typeof stdout === 'string' && stdout.trim() !== '' ? stdout : String(error.message);
    process.stderr.write(
      `cannot inspect the package: npm pack --dry-run failed (prepack runs tsc)\n${detail.trim()}\n`,
    );
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const binField = pkg.bin;
  const targets = typeof binField === 'string' ? [binField] : Object.values(binField ?? {});
  const binaries = targets.map((target) => {
    const entry = normalize(target);
    return { path: entry, head: firstLineOf(path.join(REPO_ROOT, entry)) };
  });

  const pythonDir = path.join(REPO_ROOT, 'python');
  return {
    packaged: pack.files.map((entry) => normalize(entry.path)),
    binaries,
    builtModules: readBuiltModules(),
    repoPython: existsSync(pythonDir) ? readdirSync(pythonDir) : [],
    // Every root entry that is not ignored, so a scratch file that WOULD be committed is caught here
    // rather than by a reviewer noticing it in a diff.
    rootFiles: trackedRootEntries(),
  };
}

const problems = selftest();
if (SELFTEST_ONLY) {
  if (problems.length > 0) {
    process.stderr.write(`package check self-test failed (${problems.length}):\n${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `package check self-test: ok (${SELFTEST_MATRIX.length} observations, ` +
      `${SELFTEST_MATRIX.length - 1} mutations detected, control silent)\n`,
  );
} else {
  const observation = readObservation();
  problems.push(...inspect(observation));
  if (problems.length > 0) {
    process.stderr.write(
      `package contents check failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `package contents check: ok (${observation.packaged.length} files, ` +
      `${SELFTEST_MATRIX.length - 1} mutations detected)\n`,
  );
}
