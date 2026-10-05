// Hands-on: RUN a cell in the real 37.5 MiB notebook and confirm the whole loop works on real content.
//
//   node scripts/trial-real-run.mjs <notebook>
//
// Copy the notebook first if you care about it — this writes outputs back. The run targets a single cell.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const target = process.argv[2];
if (target === undefined) {
  process.stderr.write('usage: node scripts/trial-real-run.mjs <notebook>\n');
  process.exit(2);
}
const absolute = path.resolve(target);
const workspace = path.dirname(absolute);
const sizeBefore = statSync(absolute).size;

const client = new Client({ name: 'real-run', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(import.meta.dirname, '..', 'lib', 'bin.js'), '--root', workspace],
  env: { ...process.env },
  stderr: 'pipe',
});

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
};

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).find((block) => block.type === 'text')?.text ?? '';
  return { body: JSON.parse(text), isError: result.isError === true, bytes: Buffer.byteLength(text, 'utf8') };
}

try {
  await client.connect(transport);
  process.stdout.write(`\n=== running one cell of ${path.basename(absolute)} ===\n\n`);

  const read = await call('notebook_read', { path: absolute, include_outputs: 'none', include_source: 'preview' });
  const cells = read.body.cells ?? [];
  const codeCells = cells.filter((cell) => cell.cell_type === 'code');
  check('the notebook has code cells to run', codeCells.length > 0, `code=${String(codeCells.length)}`);

  // Insert a tiny probe cell instead of running one of the user's (they train models): this exercises the
  // edit path, the run path and the write-back path on real content without touching their work.
  const probeSource = 'trial_probe = sum(range(1000))\nprint("probe", trial_probe)';
  // `insert_cell` takes `source` (not `new_text`) and FORBIDS anchors — the op matrix in SPEC §4.7 is per-op,
  // and guessing cost two failed attempts in this trial. A brand-new cell has nothing to compare against,
  // which is why the anchor is not merely optional here but rejected.
  const inserted = await call('notebook_edit', {
    path: absolute,
    ops: [{ op: 'insert_cell', at_index: 0, cell_type: 'code', source: probeSource }],
  });
  check('a probe cell can be inserted', !inserted.isError, JSON.stringify(inserted.body).slice(0, 140));
  if (inserted.isError) {
    throw new Error('cannot continue without the insert');
  }

  const run = await call('notebook_run', { path: absolute, cell_selector: '0', timeout_seconds: 180 });
  let outcome = run.body.kind === 'background' ? null : run.body;
  if (outcome === null) {
    for (let attempt = 0; attempt < 180 && outcome === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await call('notebook_run_status', { run_id: run.body.run_id });
      if (status.body.state !== 'running' && status.body.facts_pending === false) {
        outcome = status.body;
      }
    }
  }
  check('the run reached a terminal state', outcome !== null, `mode=${String(outcome?.mode_used)}`);
  const output = JSON.stringify(outcome?.executed?.[0]?.outputs ?? []);
  check('the probe produced its output', output.includes('probe') && output.includes('499500'), output.slice(0, 120));
  check(
    'the run response is inside the client limit even for a 37 MiB notebook',
    run.bytes < 10 * 1024 * 1024,
    `${(run.bytes / 1024 / 1024).toFixed(2)} MiB`,
  );

  const reread = await call('notebook_read', { path: absolute, include_outputs: 'summary', include_source: 'preview' });
  check('the cell count grew by the probe', reread.body.cell_count === (read.body.cell_count ?? 0) + 1);
  check('the write-back landed on disk', statSync(absolute).size !== sizeBefore, `${String(sizeBefore)} -> ${String(statSync(absolute).size)} bytes`);
  const onDisk = readFileSync(absolute, 'utf8');
  check('the probe source is in the file', onDisk.includes('trial_probe = sum(range(1000))'));

  // Clean up: remove the probe so the copy is as it was. `delete_cell` needs a text anchor as well — every op
  // that removes CONTENT needs one, because a delete with no anchor could destroy a cell the caller was not
  // looking at. That is the CAS rule doing its job, and it is the third op-matrix detail this trial taught me.
  const removed = await call('notebook_edit', {
    path: absolute,
    ops: [{ op: 'delete_cell', cell_index: 0, expected_text: probeSource }],
  });
  check('the probe cell can be removed again', !removed.isError, JSON.stringify(removed.body).slice(0, 120));

  const kernel = await call('notebook_kernel', { action: 'status' });
  const pid = kernel.body.kernels?.[0]?.pid ?? null;
  await call('notebook_kernel', { action: 'shutdown', path: absolute });
  check('the kernel shut down cleanly', (await call('notebook_kernel', { action: 'status' })).body.kernels.length === 0, `pid was ${String(pid)}`);
} catch (cause) {
  check(`trial threw: ${String(cause).slice(0, 200)}`, false);
} finally {
  await client.close().catch(() => undefined);
}

const failed = checks.filter((ok) => !ok).length;
process.stdout.write(`\nreal-run trial: ${String(checks.length - failed)}/${String(checks.length)} checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
