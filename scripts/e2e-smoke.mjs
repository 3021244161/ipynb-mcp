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
import { existsSync, readFileSync } from 'node:fs';
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
// A display_data whose image value is a `data:` URL. This is what people paste and
// what some tools emit, and it is the value that used to be decodable for the
// artifact and simultaneously rejected by the SDK's `ImageContent.data` validator —
// the rejection is a protocol-level `-32602` for the WHOLE tools/call, so the model
// lost the notebook, not one image (review v9 V9-1). It belongs in the smoke script
// precisely because only the real client path can see that failure shape: every unit
// assertion passed while it was broken.
const IMAGE_CELL_SOURCE = [
  "import base64, struct, zlib",
  "def chunk(t, d):",
  "    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))",
  "ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)",
  "raw = b'\\x00' + bytes([255, 0, 0])",
  // Doubled backslashes on purpose: these are PYTHON string literals inside a JS
  // string, so `\\x89` reaches the kernel as `\x89`. A single one produced real
  // control bytes and the cell died with a SyntaxError.
  "png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')",
  "display({'image/png': 'data:image/png;base64,' + base64.b64encode(png).decode()}, raw=True)",
].join('\n');
await writeFile(notebookPath, JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    language_info: { name: 'python' },
  },
  cells: [
    { cell_type: 'code', id: 'c0', metadata: {}, source: 'text = "hello"\nprint(text)\nlen(text)', outputs: [], execution_count: null },
    { cell_type: 'code', id: 'c1', metadata: {}, source: IMAGE_CELL_SOURCE, outputs: [], execution_count: null },
    { cell_type: 'code', id: 'c2', metadata: {}, source: 'text.upper()', outputs: [], execution_count: null },
    { cell_type: 'code', id: 'c3', metadata: {}, source: 'import time\ntime.sleep(30)', outputs: [], execution_count: null },
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
  const images = (result.content ?? []).filter((block) => block.type === 'image');
  return { isError: result.isError === true, text, images };
};
const parse = (result) => {
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
};

// The SDK validates `ImageContent.data` with `atob`, so that is the bar a block has
// to clear to be returnable at all. `atob` throws on a `data:` URL, on anything
// outside the base64 alphabet, and on a payload whose length cannot be re-padded.
function isServableBase64(data) {
  if (typeof data !== 'string' || data === '') {
    return false;
  }
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}

function decodeBlock(data) {
  return isServableBase64(data) ? Buffer.from(data, 'base64') : null;
}

/** Is this a block carrying the 1x1 red PNG the notebook's image cell displays? */
function isServablePng(data) {
  const bytes = decodeBlock(data);
  return bytes !== null && bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** Never print a base64 payload: the failure detail must stay readable. */
function describeBlock(data) {
  if (typeof data !== 'string') {
    return `absent (${typeof data})`;
  }
  return `len=${data.length} head=${JSON.stringify(data.slice(0, 12))}`;
}

/**
 * Wait for a run that went to the BACKGROUND path and return its terminal state.
 *
 * D14/D-015: `notebook_run` yields a handle (`{kind: 'background', run_id, …}`) once
 * `timeout_seconds * target_cells` exceeds the threshold, and the images of such a
 * run come back from `notebook_run_status`, not from the first response. The smoke
 * test used to run one cell, so it never saw this shape; adding the image cell made
 * the difference visible (and made a synchronous-only assertion quietly mean
 * something else).
 */
async function settleRun(result, label) {
  const first = parse(result);
  if (first?.kind !== 'background') {
    return { body: first, images: result.images, background: false };
  }
  const deadline = Date.now() + 180_000;
  let last = await call('notebook_run_status', { run_id: first.run_id });
  while (Date.now() < deadline) {
    const body = parse(last);
    if (body?.state !== 'running') {
      return { body, images: last.images, background: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    last = await call('notebook_run_status', { run_id: first.run_id });
  }
  throw new Error(`${label} did not settle within 180s (run_id=${String(first.run_id)})`);
}

try {
  await client.connect(transport);

  const tools = await client.listTools();
  check('tools/list returns the 6 documented tools', tools.tools.length === 6, tools.tools.map((t) => t.name).join(','));
  check(
    'no tool advertises an outputSchema (D24)',
    tools.tools.every((tool) => tool.outputSchema === undefined),
  );
  // DEP-2: the advertised version must be the manifest's, or a release can ship a
  // server that lies about which release it is.
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const clientVersion = client.getServerVersion?.();
  check(
    'the server reports the version in package.json',
    clientVersion?.version === manifest.version,
    `${String(clientVersion?.version)} vs ${String(manifest.version)}`,
  );

  const read = await call('notebook_read', { path: notebookPath });
  const readBody = parse(read);
  check('notebook_read returns parseable JSON with 6 cells', readBody?.cells?.length === 6, `cells=${readBody?.cells?.length}`);

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
    ops: [{ op: 'replace_source', cell_index: 2, expected_text: 'text.upper()', new_text: 'text.title()' }],
  });
  const editBody = parse(edit);
  check(
    'a CAS-anchored edit applies',
    edit.isError === false && editBody?.applied === 1,
    editBody?.code ?? `applied=${editBody?.applied}`,
  );

  // Run the first three cells: cell 1 produces the data-URL image, so this is also
  // the write-back half of the v9 V9-1 amplifier (the failed run used to still
  // write the data: URL to disk, and every later read of that notebook failed).
  // Cell 3 is the timeout probe and needs its own call with a short timeout.
  const run = await call('notebook_run', { path: notebookPath, cell_selector: '0-2', timeout_seconds: 60 });
  const settled = await settleRun(run, 'the three-cell run');
  const runBody = settled.body;
  const runImages = settled.images;
  const runExecuted = runBody?.executed ?? [];
  check(
    'notebook_run completes and reports write_back.performed',
    run.isError === false && runBody?.write_back?.performed === true,
    run.isError ? run.text : `mode=${String(runBody?.mode_used ?? runBody?.state)}`,
  );
  // Everything below reads the state this call wrote; a failed run makes every one
  // of those checks meaningless (and used to hide the real cause behind a cascade of
  // "absent (undefined)"). Stop here and let the failure above speak.
  if (run.isError === true) {
    throw new Error(`notebook_run failed, so the run assertions cannot be judged: ${run.text}`);
  }

  // V9-1/V9-2: the image the RUN just returned. `call()` used to collect only text
  // blocks, so a run whose image block was invalid still looked green here.
  const runImageItem = (runExecuted[1]?.outputs ?? []).find((item) => item.kind === 'image');
  check(
    'the run returned an image block for the data: URL output',
    runImageItem?.image_index === 0 && runImages.length === 1,
    `blocks=${runImages.length} item=${JSON.stringify(runImageItem ?? null)}`,
  );
  check(
    'the run image block decodes to the PNG that was displayed',
    isServablePng(runImages[0]?.data),
    describeBlock(runImages[0]?.data),
  );
  check(
    'the run artifact was written for the returned block',
    typeof runImageItem?.artifact_path === 'string' && existsSync(runImageItem.artifact_path),
    String(runImageItem?.artifact_path ?? 'null'),
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
  check('the markdown cell kept no outputs/execution_count', written.cells[4].outputs === undefined && written.cells[4].execution_count === undefined);
  check(
    'the edit reached the file',
    written.cells[2].source.join('') === 'text.title()',
    written.cells[2].source.join(''),
  );

  // Round trip at CONTENT level: a count-based assertion passed for a writer
  // that produced the right NUMBER of wrong outputs (SMOKE-1).
  const rereadCall = await call('notebook_read', { path: notebookPath, include_outputs: 'full' });
  const reread = parse(rereadCall);
  const cellOutputs = reread?.cells?.[0]?.outputs ?? [];
  const serializedOutputs = JSON.stringify(cellOutputs);
  check(
    'notebook_read reads back the TEXT that was written',
    serializedOutputs.includes('hello') && serializedOutputs.includes('5'),
    `outputs=${cellOutputs.length}`,
  );

  // V9-1: the notebook now HOLDS a data: URL image (the run wrote it), so this read
  // is the exact case that used to fail with `-32602 Invalid tools/call result` —
  // and kept failing forever after, because the failed run was what wrote the value.
  // The two checks below are the ones the review asked for: one on the call, one on
  // every image block, judged by `atob` — the validator the SDK itself uses.
  check('an image output does not fail the whole tools/call', rereadCall.isError === false, rereadCall.text.slice(0, 120));
  const badBase64 = rereadCall.images.find((block) => !isServableBase64(block.data));
  check(
    'every returned image block carries SDK-valid base64',
    rereadCall.images.length > 0 && badBase64 === undefined,
    `${rereadCall.images.length} block(s)${badBase64 === undefined ? '' : `; bad=${describeBlock(badBase64.data)}`}`,
  );
  check(
    'the read image block decodes to the PNG that was displayed',
    rereadCall.images.length === 1 && isServablePng(rereadCall.images[0]?.data),
    describeBlock(rereadCall.images[0]?.data),
  );
  const readImageItem = (reread?.cells?.[1]?.outputs ?? []).find((item) => item.kind === 'image');
  // SPEC §4.4: a returned block and a materialized artifact are the same event, so
  // the block the model received must have a file behind it that is the same bytes.
  const readImageBytes =
    typeof readImageItem?.artifact_path === 'string' && existsSync(readImageItem.artifact_path)
      ? readFileSync(readImageItem.artifact_path)
      : null;
  check(
    'the artifact behind the returned block is the same PNG',
    readImageBytes !== null &&
      isServablePng(readImageBytes.toString('base64')) &&
      readImageBytes.equals(Buffer.from(rereadCall.images[0]?.data ?? '', 'base64')),
    readImageBytes === null ? 'artifact missing' : `${readImageBytes.length} bytes`,
  );

  // A cell that runs past its timeout. What is invariant across platforms is that it
  // does NOT succeed and that the call returns promptly; the SHAPE of the outcome is
  // platform-dependent by design:
  //   - where the interrupt lands (Linux), `time.sleep` raises KeyboardInterrupt, the
  //     kernel goes idle, and the cell ends as an `error` — the interrupt is a
  //     success, so reporting `exec_timeout` would be wrong;
  //   - where it does not (Windows, no console for the interrupt), the sidecar returns
  //     `exec_timeout` after the grace period (SPEC §4.7 rule 5, D-025/D-033).
  // Asserting only the Windows shape made this a platform-conditional failure on
  // ubuntu-latest, which is exactly why the smoke test now runs in CI.
  const timeoutStartedAt = Date.now();
  const timedOut = await call('notebook_run', { path: notebookPath, cell_selector: '3', timeout_seconds: 2 });
  const timeoutMs = Date.now() - timeoutStartedAt;
  const timedOutBody = parse(timedOut);
  const timedOutAsTimeout = timedOut.isError === true && timedOutBody?.code === 'exec_timeout';
  const timedOutAsInterrupt =
    timedOut.isError !== true &&
    Array.isArray(timedOutBody?.executed) &&
    timedOutBody.executed[0]?.status !== 'ok' &&
    JSON.stringify(timedOutBody.executed[0]?.outputs ?? []).includes('KeyboardInterrupt');
  check(
    'a cell that outlives its timeout does not report success',
    timedOutAsTimeout || timedOutAsInterrupt,
    timedOutAsTimeout ? 'exec_timeout' : `interrupted: ${timedOutBody?.executed?.[0]?.status}`,
  );
  // Generous ceiling: the budget is timeout + interrupt grace, measured at about
  // +10 s including teardown on Windows. Anything close to the cell's own 30 s
  // means the outcome is not being reported promptly.
  check('the timeout was reported promptly', timeoutMs < 25_000, `${timeoutMs} ms`);
  check(
    'the cell that outlived its timeout kept no fresh success state',
    (() => {
      const after = JSON.parse(readFileSync(notebookPath, 'utf8'));
      // Where the interrupt landed, the cell DID run and DOES carry the interrupt's
      // error output — that is the true record and must be kept. What must never
      // appear is a half-written cell that looks like a successful run.
      return after.cells[3].outputs.length === 0 || timedOutAsInterrupt;
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
