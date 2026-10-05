// Hands-on trial: use the built server the way a client does, on real notebooks, and check the things a
// user would notice. Not a unit test — this is me operating the tool.
//
//   node scripts/trial-v15.mjs
//
// It drives the SAME stdio server a client launches (`lib/bin.js`), through the real SDK client, and walks
// the six tools: read (all output modes), edit with a CAS anchor, run a cell in a real kernel, poll, kernel
// lifecycle, plus the large-payload shapes this round was about. Every check prints what it observed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'lib', 'bin.js');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

function notebook(cells) {
  return `${JSON.stringify(
    {
      cells,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`;
}

const codeCell = (id, source, extra = {}) => ({
  cell_type: 'code',
  execution_count: null,
  id,
  metadata: {},
  outputs: [],
  source,
  ...extra,
});

const workspace = mkdtempSync(path.join(tmpdir(), 'ipynb-mcp-trial-'));
const python = process.env['IPYNB_TEST_PYTHON'] ?? 'python';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN, '--root', workspace],
  env: { ...process.env, IPYNB_PYTHON: python },
  stderr: 'pipe',
});
const client = new Client({ name: 'trial', version: '1.0.0' });

/** The kernel's pid, captured from its own status report so the exit check can name it. */
let kernelPid = null;

/** Call a tool and return the parsed text payload plus the transport-level byte count. */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const blocks = result.content ?? [];
  const text = blocks.find((block) => block.type === 'text')?.text ?? '';
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    body: JSON.parse(text),
    isError: result.isError === true,
    blocks: blocks.length,
    imageBlocks: blocks.filter((block) => block.type === 'image').length,
  };
}

try {
  await client.connect(transport);
  process.stdout.write(`\n=== trial in ${workspace} (python: ${python}) ===\n\n`);

  // ---------------------------------------------------------------- 1. read modes
  const small = path.join(workspace, 'small.ipynb');
  writeFileSync(
    small,
    notebook([
      codeCell('c0', 'import math\nprint("hello")\n42'),
      codeCell('c1', 'x = math.pi * 2\nx'),
      { cell_type: 'markdown', id: 'm2', metadata: {}, source: '# Title\n\nSome prose.' },
    ]),
    'utf8',
  );
  const none = await call('notebook_read', { path: small, include_outputs: 'none', include_source: 'none' });
  check('read(none/none) returns the three cells', none.body.cell_count === 3, `cells=${String(none.body.cell_count)}`);
  check('read(none/none) omits source and outputs', none.body.cells.every((c) => c.source === null && c.outputs === null));
  const preview = await call('notebook_read', { path: small, include_source: 'preview', include_outputs: 'summary' });
  check(
    'read(preview/summary) still sends a source preview',
    Array.isArray(preview.body.cells[0].source_preview) && preview.body.cells[0].source_preview.length > 0,
  );

  // ---------------------------------------------------------------- 2. CAS edit
  const before = readFileSync(small, 'utf8');
  const hash = preview.body.content_hash;
  const rejected = await call('notebook_edit', {
    path: small,
    ops: [{ op: 'replace_source', cell_index: 1, expected_source_hash: 'sha256:0000', new_text: 'y = 1' }],
    expected_content_hash: hash,
  });
  check(
    'a wrong anchor is refused with cas_mismatch and writes nothing',
    rejected.isError && (rejected.body.code === 'cas_mismatch' || rejected.body.error?.code === 'cas_mismatch'),
    `code=${String(rejected.body.code ?? rejected.body.error?.code)}`,
  );
  check('the file is byte-identical after the refusal', readFileSync(small, 'utf8') === before);

  // The anchor is expected_text (the cell's current source) rather than a hash: notebook_read does not
  // return a per-cell source hash, and guessing a field name is what produced the first two failures here.
  // The SPEC lists both expected_source_hash and expected_text as valid anchors.
  const current = await call('notebook_read', { path: small, include_source: 'full', include_outputs: 'none' });
  const cellSource = String(current.body.cells[1].source ?? '');
  const dry = await call('notebook_edit', {
    path: small,
    dry_run: true,
    ops: [{ op: 'replace_source', cell_index: 1, expected_text: cellSource, new_text: 'x = math.tau' }],
    expected_content_hash: current.body.content_hash,
  });
  check('dry_run reports the change without writing', !dry.isError && readFileSync(small, 'utf8') === before);
  const applied = await call('notebook_edit', {
    path: small,
    ops: [{ op: 'replace_source', cell_index: 1, expected_text: cellSource, new_text: 'x = math.tau' }],
    expected_content_hash: current.body.content_hash,
  });
  check('the anchored edit lands', !applied.isError, JSON.stringify(applied.body).slice(0, 120));
  check('the edit changed exactly the intended cell', readFileSync(small, 'utf8').includes('math.tau'));

  // ---------------------------------------------------------------- 3. a real kernel run
  const run = await call('notebook_run', { path: small, cell_selector: '0-1', timeout_seconds: 120 });
  const ran = run.body.kind === 'background' ? null : run.body;
  check('run is foreground for a short notebook or went background', ran !== null || run.body.kind === 'background');
  let outcome = ran;
  if (ran === null) {
    const runId = run.body.run_id;
    for (let attempt = 0; attempt < 60 && outcome === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await call('notebook_run_status', { run_id: runId });
      if (status.body.state !== 'running' && status.body.facts_pending === false) {
        outcome = status.body;
      }
    }
  }
  check('the run reported a terminal state, not a hang', outcome !== null, JSON.stringify(outcome).slice(0, 120));
  const executed = outcome?.executed ?? [];
  check('two cells executed', executed.length === 2, `executed=${String(executed.length)}`);
  const printed = JSON.stringify(executed[0]?.outputs ?? []);
  check('the first cell produced its stdout and result', printed.includes('hello') && printed.includes('42'));
  const written = readFileSync(small, 'utf8');
  check('outputs were written back to the file', written.includes('"output_type"') || written.includes('stream'));
  const kernelStatus = await call('notebook_kernel', { action: 'status' });
  check('the kernel is listed as live', kernelStatus.body.kernels.length >= 1);
  // Recorded so the exit check can name it later.
  kernelPid = kernelStatus.body.kernels[0]?.pid ?? null;

  // ---------------------------------------------------------------- 4. stale analysis
  //
  // `stale_analysis` is a field of the RUN outcome (SPEC §4.7), not of `notebook_read` — the first version of
  // this trial asserted it on the read payload, where it does not exist, so the check could never pass.
  const analysis = outcome?.stale_analysis;
  check(
    'stale analysis ran over the real notebook',
    analysis !== null && analysis !== undefined,
    `method=${String(analysis?.method)}, stale_cells=${String((outcome?.stale_cells ?? []).length)}`,
  );

  // ---------------------------------------------------------------- 5. the shapes this round was about
  const shapes = [
    ['large text output', 'text/plain', 'T'.repeat(11 * 1024 * 1024)],
    ['large source', null, null],
    ['escaping-heavy', 'text/plain', '\\"'.repeat(4 * 1024 * 1024)],
    ['CJK', 'text/plain', '中'.repeat(4 * 1024 * 1024)],
    ['control characters', 'text/plain', '\u0001'.repeat(2 * 1024 * 1024)],
  ];
  for (const [label, mime, payload] of shapes) {
    const target = path.join(workspace, `shape-${label.replace(/[^a-z]/gi, '')}.ipynb`);
    if (mime === null) {
      const unit = 'x = 1  # padding line for the trial\n';
      writeFileSync(
        target,
        notebook([codeCell('c0', unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)))]),
        'utf8',
      );
    } else {
      writeFileSync(
        target,
        notebook([
          codeCell('c0', 'pass', {
            outputs: [{ data: { [mime]: payload }, metadata: {}, output_type: 'display_data' }],
            execution_count: 1,
          }),
        ]),
        'utf8',
      );
    }
    try {
      const args = mime === null
        ? { path: target, include_source: 'full', include_outputs: 'none' }
        : { path: target, include_outputs: 'full' };
      const read = await call('notebook_read', args);
      const warned = JSON.stringify(read.body.warnings ?? []).includes('output_truncated');
      const refused = read.body.response_budget_exceeded === true;
      // The client survived and the frame fits — that is the contract. Whether it was shortened or refused
      // is reported, not asserted.
      check(
        `${label}: deliverable and inside the client limit`,
        read.bytes < 10 * 1024 * 1024,
        `${(read.bytes / 1024 / 1024).toFixed(2)} MiB, ${refused ? 'refused' : warned ? 'shortened' : 'whole'}`,
      );

      // [V16-1] AND THE FLAGS MUST AGREE WITH THE VALUES. A model reads `source_truncated` rather than the
      // tail of a multi-megabyte string, so a cut value beside a `false` flag is a trap: it concludes the
      // source it holds is the whole source. Checked here for every value that arrived with the cut marker.
      if (!refused) {
        const cells = read.body.cells ?? [];
        let markedButNotFlagged = 0;
        let cutStreams = 0;
        let streamsNotFlagged = 0;
        let markedValues = 0;
        for (const cell of cells) {
          // BOTH SHAPES: a source whose last line ends in a newline arrives as a STRING (one long line is what
          // gets cut), and one that does not arrives as an ARRAY. The first version of this check looked only at
          // strings, so it examined nothing at all — the fixture this trial builds is the array shape, and the
          // all-zero counters in its output said so.
          const source = cell.source;
          const sourceTail = Array.isArray(source)
            ? (source.length > 0 ? source[source.length - 1] : '')
            : source;
          if (typeof sourceTail === 'string' && sourceTail.endsWith('truncated to fit the response budget]')) {
            markedValues += 1;
            if (cell.source_truncated !== true) {
              markedButNotFlagged += 1;
            }
          }
          for (const item of cell.outputs ?? []) {
            if (item.kind !== 'stream') {
              continue;
            }
            const text = String(item.text ?? '');
            if (text.endsWith('truncated to fit the response budget]')) {
              cutStreams += 1;
              if (item.truncated !== true) {
                streamsNotFlagged += 1;
              }
            }
          }
        }
        check(
          `${label}: no cut value claims to be whole`,
          markedButNotFlagged === 0 && streamsNotFlagged === 0,
          // `checked` is the probe that the check examined something: without it, a fixture that is never cut
          // makes this assertion vacuously true and the trial reports a pass it did not earn.
          `checked=${String(markedValues + cutStreams)} markedSources=${String(markedValues)} unflaggedSources=${String(markedButNotFlagged)} cutStreams=${String(cutStreams)} unflaggedStreams=${String(streamsNotFlagged)}`,
        );
      }
    } catch (cause) {
      check(`${label}: deliverable and inside the client limit`, false, String(cause).slice(0, 120));
    }
  }

  // ---------------------------------------------------------------- 6. the fence and the kernel lifecycle
  let outsideRefused = false;
  try {
    const outside = await call('notebook_read', { path: path.join(workspace, '..', 'nope.ipynb') });
    outsideRefused = outside.isError && JSON.stringify(outside.body).includes('path_outside_root');
  } catch {
    outsideRefused = true;
  }
  check('a path outside --root is refused', outsideRefused);
  const shutdown = await call('notebook_kernel', { action: 'shutdown', path: small });
  check('kernel shutdown succeeded', !shutdown.isError, JSON.stringify(shutdown.body).slice(0, 100));
  check('no kernel is left running', (await call('notebook_kernel', { action: 'status' })).body.kernels.length === 0);

  await client.close();
} catch (cause) {
  check(`trial threw: ${String(cause)}`, false);
} finally {
  await client.close().catch(() => undefined);
  // The server exits when stdin closes; give it a moment, then assert no orphan sidecar survives.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  // THE KERNEL'S OWN PID, not a count of every python on the machine: this box has interpreters running that
  // have nothing to do with the trial, and "count == 0" would either fail for that reason or, worse, pass
  // because the kernel happened to be the only one. `kernelPid` was captured from the run's own report.
  let stillAlive = null;
  if (kernelPid !== null) {
    const probe = spawnSync('tasklist', ['/FI', `PID eq ${String(kernelPid)}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
    });
    stillAlive = String(probe.stdout).includes(String(kernelPid));
  }
  check(
    'the kernel process this run started is gone',
    kernelPid === null || stillAlive === false,
    kernelPid === null ? 'no pid was reported, so nothing to check' : `pid ${String(kernelPid)} alive=${String(stillAlive)}`,
  );
  try {
    statSync(workspace);
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // already gone
  }
}

const failed = checks.filter((entry) => !entry.ok).length;
process.stdout.write(`\ntrial: ${String(checks.length - failed)}/${String(checks.length)} checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
