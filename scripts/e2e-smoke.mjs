#!/usr/bin/env node
// End-to-end smoke: the REAL stdio server, driven by the REAL MCP client SDK,
// against a temporary workspace (review v4's process recommendation).
//
// Why this exists as a script rather than only as a test: a smoke run with a
// real client found a 🔴 that three rounds of unit + integration review had
// missed, because the whole suite spoke the same private dialect the writer
// spoke. Two rules follow from that and are encoded here:
//   1. drive the product the way a client does (spawn `lib/bin.js`, speak
//      JSON-RPC over stdio, no internal imports), and
//   2. CHECK THE RESULT WITH SOMETHING THAT DOES NOT SHARE OUR ASSUMPTIONS —
//      here Python's `nbformat.validate`, which is the authority on the file
//      format the product claims to produce.
//
// Usage: node scripts/e2e-smoke.mjs [--python <interpreter>] [--keep]
// Requires a build (`npm run build`) and an interpreter with ipykernel.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const pythonFlag = argv.indexOf('--python');
const explicitPython = pythonFlag >= 0 ? argv[pythonFlag + 1] : undefined;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

function resolvePython() {
  const candidates = [
    explicitPython,
    process.env['IPYNB_TEST_PYTHON'],
    path.join(REPO_ROOT, 'tests', '.venv-test', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter((entry) => typeof entry === 'string' && entry !== '');
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      continue;
    }
    if (spawnSync(candidate, ['-c', 'import nbformat, ipykernel'], { timeout: 20_000 }).status === 0) {
      return candidate;
    }
  }
  return null;
}

const python = resolvePython();
if (python === null) {
  process.stdout.write('SKIP  no interpreter with nbformat + ipykernel; nothing to smoke\n');
  process.exit(0);
}

if (!existsSync(path.join(REPO_ROOT, 'lib', 'bin.js'))) {
  process.stderr.write('lib/bin.js is missing: run `npm run build` first\n');
  process.exit(2);
}

const workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-smoke-'));
const notebookPath = path.join(workspace, 'smoke.ipynb');
await writeFile(notebookPath, JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    language_info: { name: 'python' },
  },
  cells: [
    { cell_type: 'code', id: 'c0', metadata: {}, source: 'text = "hello"\nprint(text)\nlen(text)', outputs: [], execution_count: null },
    { cell_type: 'code', id: 'c1', metadata: {}, source: 'text.upper()', outputs: [], execution_count: null },
    { cell_type: 'code', id: 'c2', metadata: {}, source: 'import time\ntime.sleep(30)', outputs: [], execution_count: null },
    { cell_type: 'markdown', id: 'm0', metadata: {}, source: '# title' },
    { cell_type: 'markdown', id: 'm1', metadata: {}, source: 'to be converted' },
  ],
}));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, 'lib', 'bin.js'), '--root', workspace],
  cwd: workspace,
  stderr: 'pipe',
});
const client = new Client({ name: 'ipynb-mcp-smoke', version: '0.0.0' });

let stderrText = '';
transport.stderr?.on('data', (chunk) => {
  stderrText += chunk.toString('utf8');
});

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  return { isError: result.isError === true, text };
};
const parse = (result) => {
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
};

try {
  await client.connect(transport);

  const tools = await client.listTools();
  check('tools/list returns the 6 documented tools', tools.tools.length === 6, tools.tools.map((t) => t.name).join(','));
  check(
    'no tool advertises an outputSchema (D24)',
    tools.tools.every((tool) => tool.outputSchema === undefined),
  );

  const read = await call('notebook_read', { path: notebookPath });
  const readBody = parse(read);
  check('notebook_read returns parseable JSON with 5 cells', readBody?.cells?.length === 5, `cells=${readBody?.cells?.length}`);

  // The unknown-argument check must come from the TOOL layer (SPEC §4.1.12),
  // not from the SDK's schema validation (review v4 NEW-1).
  const bogus = await call('notebook_read', { path: notebookPath, cell_selector: '0' });
  const bogusBody = parse(bogus);
  check(
    'an unknown argument is rejected with invalid_arguments by the tool layer',
    bogus.isError && bogusBody?.code === 'invalid_arguments' && bogusBody?.detail?.field === 'cell_selector',
    bogusBody?.code ?? bogus.text.slice(0, 60),
  );

  // EDIT before RUN: the review found that this script never called
  // notebook_edit, so a failure mode that lives only on the edit path (the write
  // gate rejecting an edit it should have allowed) was invisible to it (SMOKE-1).
  const edit = await call('notebook_edit', {
    path: notebookPath,
    ops: [{ op: 'replace_source', cell_index: 1, expected_text: 'text.upper()', new_text: 'text.title()' }],
  });
  const editBody = parse(edit);
  check(
    'a CAS-anchored edit applies',
    edit.isError === false && editBody?.applied === 1,
    editBody?.code ?? `applied=${editBody?.applied}`,
  );

  // Run only the first two cells: cell 2 is the timeout probe and needs its own
  // call with a short timeout.
  const run = await call('notebook_run', { path: notebookPath, cell_selector: '0-1', timeout_seconds: 120 });
  const runBody = parse(run);
  check(
    'notebook_run completes and reports write_back.performed',
    run.isError === false && runBody?.mode_used !== undefined && runBody?.write_back?.performed === true,
    runBody?.mode_used,
  );

  // The check that matters: an authority that does not share our assumptions.
  const validation = spawnSync(python, ['-c', 'import sys, nbformat; nbformat.validate(nbformat.read(sys.argv[1], as_version=4))', notebookPath], { timeout: 30_000 });
  check(
    'the written notebook passes Python nbformat.validate',
    validation.status === 0,
    validation.status === 0 ? undefined : validation.stderr.toString().split('\n').slice(-1)[0],
  );

  const written = JSON.parse(await readFile(notebookPath, 'utf8'));
  const outputs = written.cells[0].outputs;
  check(
    'stored outputs use nbformat keys (no protocol-shaped outputType)',
    outputs.length >= 2 && outputs.every((output) => output.output_type !== undefined && output.outputType === undefined),
  );
  check(
    'the execute_result carries execution_count (nbformat requires it there)',
    outputs.some((output) => output.output_type === 'execute_result' && 'execution_count' in output),
  );
  check('the markdown cell kept no outputs/execution_count', written.cells[3].outputs === undefined && written.cells[3].execution_count === undefined);
  check(
    'the edit reached the file',
    written.cells[1].source.join('') === 'text.title()',
    written.cells[1].source.join(''),
  );

  // Round trip at CONTENT level: a count-based assertion passed for a writer
  // that produced the right NUMBER of wrong outputs (SMOKE-1).
  const reread = parse(await call('notebook_read', { path: notebookPath, include_outputs: 'full' }));
  const cellOutputs = reread?.cells?.[0]?.outputs ?? [];
  const serializedOutputs = JSON.stringify(cellOutputs);
  check(
    'notebook_read reads back the TEXT that was written',
    serializedOutputs.includes('hello') && serializedOutputs.includes('5'),
    `outputs=${cellOutputs.length}`,
  );

  // A timed-out cell: SPEC §4.7 rule 5 must report exec_timeout, and the run
  // must not hang for the cell's full duration (the sidecar returns as soon as
  // the interrupt grace expires instead of waiting for a reply that cannot come).
  const timeoutStartedAt = Date.now();
  const timedOut = await call('notebook_run', { path: notebookPath, cell_selector: '2', timeout_seconds: 2 });
  const timeoutMs = Date.now() - timeoutStartedAt;
  const timedOutBody = parse(timedOut);
  check(
    'a timed-out cell reports exec_timeout',
    timedOut.isError === true && timedOutBody?.code === 'exec_timeout',
    timedOutBody?.code ?? timedOut.text.slice(0, 60),
  );
  // Generous ceiling: the budget is timeout + interrupt grace, measured at about
  // +10 s including teardown on Windows. Anything close to the cell's own 30 s
  // means the timeout is not being reported promptly.
  check('the timeout was reported promptly', timeoutMs < 25_000, `${timeoutMs} ms`);
  check(
    'the timed-out cell kept its pre-run state',
    (() => {
      const after = JSON.parse(readFileSync(notebookPath, 'utf8'));
      return after.cells[2].execution_count === null && after.cells[2].outputs.length === 0;
    })(),
  );

  // No residue: the kernel tool must be able to shut everything down, and the
  // session must not leave a kernel behind (SMOKE-1).
  const shutdown = await call('notebook_kernel', { action: 'shutdown', path: notebookPath });
  check('kernel shutdown succeeds', shutdown.isError === false, parse(shutdown)?.code);
  const status = parse(await call('notebook_kernel', { action: 'status' }));
  check('no kernel is reported after shutdown', Array.isArray(status?.kernels) && status.kernels.length === 0, `kernels=${status?.kernels?.length}`);

  // stdout must stay pure JSON-RPC: the transport's stderr is separate, so a
  // leak would have broken connect()/listTools() above, but the log line proves
  // diagnostics went to the right stream.
  check('diagnostics went to stderr, not stdout', stderrText.includes('[ipynb-mcp]'));

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`workspace kept for inspection: ${workspace}\n`);
    process.exitCode = 1;
  }
} catch (cause) {
  process.stdout.write(`FAIL  smoke run threw: ${String(cause)}\n`);
  process.stdout.write(`workspace kept for inspection: ${workspace}\n`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  if (process.exitCode !== 1 && !keep) {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
