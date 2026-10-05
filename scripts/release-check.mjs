#!/usr/bin/env node
// Drive the INSTALLED package over real stdio, exactly as a client would.
//
// `pnpm smoke` runs `lib/` from the repository. This script does what a user does instead:
// `npm pack`, install the tarball into an empty directory, and talk to the installed binary
// with real JSON-RPC — six tools, a real kernel, a real execution. That is the one step a
// release can get wrong while every repository gate stays green (a file missing from `files`,
// a `bin` path that does not survive packing, a dependency that is only a devDependency).
//
//     pnpm check:release
//
// It needs Python with ipykernel, like the integration suite, and it is deliberately NOT part
// of `pnpm lint`/`pnpm test`: it shells out to npm and installs a package, which the default
// suites must not do (AGENTS §3). Run it before publishing.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = mkdtempSync(path.join(tmpdir(), 'ipynb-mcp-release-'));

/**
 * Run a command, failing loudly.
 *
 * `shell: true` on Windows only, and it is not optional: `npm` there is a `.cmd` shim and
 * `spawnSync` without a shell reports `status: null` rather than running it. That combination
 * raises DEP0190 ("arguments are concatenated"), which is why the warning is silenced below —
 * every argument here is a literal from this file or the package's own version, so there is
 * nothing to concatenate wrong. (Naming `npm.cmd` explicitly does not work either: Windows
 * needs the shell to resolve it.)
 */
function step(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    // The DEP0190 warning is about escaping, and every argument here is a literal from this
    // file or the package version; silencing it keeps the output readable for a release run.
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    process.stderr.write(`${command} ${args.join(' ')} failed (${String(result.status)})\n`);
    process.stderr.write(String(result.stderr).slice(0, 2000));
    process.exit(2);
  }
  return String(result.stdout);
}

const NPM = 'npm';
const version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

process.stdout.write(`packing ipynb-mcp-server@${String(version)} into ${SANDBOX}\n`);
step(NPM, ['pack', '--pack-destination', SANDBOX]);
const tarball = path.join(SANDBOX, `ipynb-mcp-server-${String(version)}.tgz`);
step(NPM, ['init', '-y'], { cwd: SANDBOX });
step(NPM, ['install', tarball, '--no-audit', '--no-fund'], { cwd: SANDBOX });

const BIN = path.join(SANDBOX, 'node_modules', 'ipynb-mcp-server', 'lib', 'bin.js');
const workspace = mkdtempSync(path.join(tmpdir(), 'ipynb-mcp-release-ws-'));
mkdirSync(workspace, { recursive: true });
const notebook = path.join(workspace, 'release-check.ipynb');
writeFileSync(
  notebook,
  `${JSON.stringify(
    {
      cells: [
        { cell_type: 'code', execution_count: null, id: 'c0', metadata: {}, outputs: [], source: 'print(6 * 7)' },
        { cell_type: 'markdown', id: 'm1', metadata: {}, source: '# Release check' },
      ],
      metadata: {
        kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`,
  'utf8',
);

const child = spawn(process.execPath, [BIN, '--root', workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
  let index = stdout.indexOf('\n');
  while (index >= 0) {
    const line = stdout.slice(0, index);
    stdout = stdout.slice(index + 1);
    if (line.trim() !== '') {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // The parser's message adds nothing here; the failing LINE is the diagnosis.
        process.stdout.write(`FAIL stdout line is not JSON: ${line.slice(0, 120)}\n`);
        process.exitCode = 1;
        continue;
      }
      const resolve = pending.get(parsed.id);
      if (resolve !== undefined) {
        pending.delete(parsed.id);
        resolve(parsed);
      }
    }
    index = stdout.indexOf('\n');
  }
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

function request(method, params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 120_000);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function textOf(response) {
  const content = response?.result?.content ?? [];
  const first = content.find((block) => block.type === 'text');
  return first === undefined ? '' : first.text;
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}\n`);
};

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'release-check', version: '1.0.0' },
  });
  check('initialize handshake', init.result?.serverInfo?.name === 'ipynb-mcp-server', JSON.stringify(init.result?.serverInfo));
  notify('notifications/initialized', {});

  const tools = await request('tools/list', {});
  const names = (tools.result?.tools ?? []).map((tool) => tool.name).sort();
  const expected = [
    'notebook_edit',
    'notebook_kernel',
    'notebook_read',
    'notebook_run',
    'notebook_run_cancel',
    'notebook_run_status',
  ];
  check('six tools, exact names', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
  check(
    'no tool declares structuredContent/outputSchema',
    (tools.result?.tools ?? []).every((tool) => tool.outputSchema === undefined),
  );

  const read = await request('tools/call', {
    name: 'notebook_read',
    arguments: { path: notebook },
  });
  const readText = textOf(read);
  check('read returns a text block', readText !== '', JSON.stringify(read).slice(0, 200));
  const readBody = JSON.parse(readText);
  check('read returns the notebook', readBody.cell_count === 2, JSON.stringify(readBody).slice(0, 160));
  check('read payload has exactly one text block', (read.result?.content ?? []).length === 1);
  check('no image block without images', (read.result?.content ?? []).every((block) => block.type === 'text'));

  const run = await request('tools/call', {
    name: 'notebook_run',
    arguments: { path: notebook, cell_selector: '0', timeout_seconds: 120 },
  });
  const runBody = JSON.parse(textOf(run));
  const ran = JSON.stringify(runBody).includes('42');
  check('run executed the cell in a real kernel', ran, JSON.stringify(runBody).slice(0, 200));

  const kernel = await request('tools/call', { name: 'notebook_kernel', arguments: { action: 'status', path: notebook } });
  check('kernel status answers', /kernel|running|interpreter/.test(textOf(kernel)), textOf(kernel).slice(0, 160));

  const shutdown = await request('tools/call', {
    name: 'notebook_kernel',
    arguments: { action: 'shutdown', path: notebook },
  });
  check('kernel shutdown answers', textOf(shutdown).includes('shutdown'), textOf(shutdown).slice(0, 120));

  child.stdin.end();
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 15_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(String(code));
    });
  });
  check('server exits after stdin closes', exited === '0' || exited === 'null', `exit=${exited}`);
  check('stderr carries no unexpected error', !/unhandled|TypeError/.test(stderr), stderr.slice(0, 200));
} catch (cause) {
  check(`driver threw: ${String(cause)}`, false);
  child.kill();
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(SANDBOX, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok).length;
process.stdout.write(`\nrelease check: ${String(checks.length - failed)}/${String(checks.length)} checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
