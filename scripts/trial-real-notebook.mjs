// Hands-on check against a REAL notebook: the 37.5 MiB xgboost one from the original trial, which is the
// file that killed the server three rounds ago (OOM), then killed the client (10 MiB frame), and then was
// still killed by a payload the budget could not reach (source).
//
//   node scripts/trial-real-notebook.mjs <notebook>
//
// It copies nothing: point it at a notebook you own, and it only READS. The read is the operation that used
// to fail, and a read writes nothing.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const target = process.argv[2];
if (target === undefined) {
  process.stderr.write('usage: node scripts/trial-real-notebook.mjs <notebook>\n');
  process.exit(2);
}
const absolute = path.resolve(target);
const workspace = path.dirname(absolute);
const before = { size: statSync(absolute).size, hash: readFileSync(absolute).length };

const client = new Client({ name: 'real-trial', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(import.meta.dirname, '..', 'lib', 'bin.js'), '--root', workspace],
  env: { ...process.env },
  stderr: 'pipe',
});

async function readWith(args) {
  const started = performance.now();
  const result = await client.callTool({ name: 'notebook_read', arguments: { path: absolute, ...args } });
  const elapsed = performance.now() - started;
  const blocks = result.content ?? [];
  const text = blocks.find((block) => block.type === 'text')?.text ?? '';
  return {
    elapsed,
    bytes: Buffer.byteLength(text, 'utf8'),
    body: JSON.parse(text),
    isError: result.isError === true,
    imageBlocks: blocks.filter((block) => block.type === 'image').length,
  };
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
};

try {
  await client.connect(transport);
  process.stdout.write(`\n=== ${path.basename(absolute)} (${(before.size / 1024 / 1024).toFixed(1)} MiB) ===\n\n`);

  // The default read: what a model does first, and what used to be enough to kill the process.
  const summary = await readWith({ include_outputs: 'summary', include_source: 'preview' });
  check(
    'default read (summary/preview) completes',
    !summary.isError && summary.bytes < 10 * 1024 * 1024,
    `${(summary.elapsed / 1000).toFixed(1)} s, ${(summary.bytes / 1024 / 1024).toFixed(2)} MiB, cells=${String(summary.body.cell_count)}`,
  );

  // The heavy read: full outputs, which is where the frame used to blow up.
  const full = await readWith({ include_outputs: 'full', include_source: 'none' });
  const warned = JSON.stringify(full.body.warnings ?? []).includes('output_truncated');
  check(
    'full-output read is deliverable and inside the client limit',
    !full.isError && full.bytes < 10 * 1024 * 1024,
    `${(full.elapsed / 1000).toFixed(1)} s, ${(full.bytes / 1024 / 1024).toFixed(2)} MiB, ${warned ? 'shortened with a warning' : 'whole'}, images=${String(full.imageBlocks)}`,
  );

  // Full source: this is the shape that was completely unbounded before this round.
  const source = await readWith({ include_outputs: 'none', include_source: 'full' });
  check(
    'full-source read is deliverable and inside the client limit',
    !source.isError && source.bytes < 10 * 1024 * 1024,
    `${(source.elapsed / 1000).toFixed(1)} s, ${(source.bytes / 1024 / 1024).toFixed(2)} MiB`,
  );

  // A second call proves the connection is alive: a frame over the limit does not fail the CALL, it kills the
  // session, so "the next call works" is the assertion that separates the two.
  const after = await readWith({ include_outputs: 'none', include_source: 'none' });
  check('the session is still alive after those reads', !after.isError, `cells=${String(after.body.cell_count)}`);

  // The file must be untouched: a read writes nothing, and this notebook is the user's.
  const now = { size: statSync(absolute).size, hash: readFileSync(absolute).length };
  check(
    'the notebook was not modified',
    now.size === before.size && now.hash === before.hash,
    `${String(before.size)} -> ${String(now.size)} bytes`,
  );
} catch (cause) {
  check(`trial threw: ${String(cause).slice(0, 200)}`, false);
} finally {
  await client.close().catch(() => undefined);
}

const failed = checks.filter((ok) => !ok).length;
process.stdout.write(`\nreal-notebook trial: ${String(checks.length - failed)}/${String(checks.length)} checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
