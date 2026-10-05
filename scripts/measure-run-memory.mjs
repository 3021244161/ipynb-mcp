// Measure the server's peak memory while it runs a notebook of a given size.
//
// The trial report: a 37.5 MB notebook makes `notebook_run` die with "Ineffective mark-compacts
// near heap limit" at a 2048 MB heap, the client sees only `-32000 Connection closed`, and every
// kernel on that server dies with the process. A guard for it needs the amplification factor, and
// the factor has to be measured on the real path — the built server over stdio — rather than
// guessed from the parser's allocations.
//
//   node scripts/measure-run-memory.mjs 8 16 24
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'lib', 'bin.js');

/**
 * Report probe failures and FAIL the run.
 *
 * Loud on purpose. The silent version collected these into an array nobody read, so a probe that never
 * worked still printed `ratio=0.0` — a plausible-looking measurement of nothing, which is worse than a
 * tool that stops (v13 V13-3②, only actually closed in v14 V14-6①).
 */
export function reportSampleFailures(errors) {
  if (errors.length === 0) {
    return;
  }
  process.stderr.write(
    `probe sampling failed ${String(errors.length)} time(s); the numbers below are NOT measurements\n`,
  );
  for (const error of errors.slice(0, 3)) {
    process.stderr.write(`  ${error}\n`);
  }
  process.exitCode = 1;
}

/**
 * Peak working set of a process, in bytes, sampled until it exits.
 *
 * Windows has no cheap per-process memory API from Node, so this polls the OS. Sampling from the
 * PARENT's own `process.memoryUsage()` was the first version and measured nothing: the server runs
 * in the child, which is the process under test.
 */
function watchPeak(child, intervalMs = 100) {
  const state = { peak: 0, timer: null };
  const sampleErrors = [];
  const sample = () => {
    if (child.exitCode !== null || child.pid === undefined) {
      return;
    }
    try {
      const ps = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${String(child.pid)} -ErrorAction SilentlyContinue).PeakWorkingSet64`,
        ],
        { encoding: 'utf8' },
      );
      const value = Number(String(ps.stdout).trim());
      if (Number.isFinite(value) && value > state.peak) {
        state.peak = value;
      }
    } catch (cause) {
      // A sample that cannot be taken is NOT silently fine: the child may have exited between the check
      // and this call, but it may equally be that PowerShell is missing or refusing to run — and the
      // symptom of the old silent catch was a report showing `ratio=0.0`, which reads like a real
      // measurement rather than a broken probe (review v13 V13-3②).
      sampleErrors.push(String(cause));
    }
  };
  sample();
  state.timer = setInterval(sample, intervalMs);
  return { ...state, errors: sampleErrors };
}
/** A notebook of roughly `megabytes` whose single json output holds long payloads. */
function build(megabytes) {
  const payload = 'x'.repeat(200_000);
  const outputs = [];
  for (let index = 0; index < (megabytes * 1024 * 1024) / payload.length; index += 1) {
    outputs.push({
      data: { 'application/json': { blob: payload, index } },
      metadata: {},
      output_type: 'display_data',
    });
  }
  return `${JSON.stringify({
    cells: [{ cell_type: 'code', execution_count: 1, id: 'c0', metadata: {}, outputs, source: ['x = 1'] }],
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1)}\n`;
}

const workspace = mkdtempSync(path.join(tmpdir(), 'ipynb-mcp-mem-'));
const sizes = process.argv.slice(2).map(Number);
process.stdout.write(`file MiB | peak RSS MiB | ratio | reply\n`);

for (const megabytes of sizes) {
  const target = path.join(workspace, `size-${String(megabytes)}.ipynb`);
  const text = build(megabytes);
  writeFileSync(target, text, 'utf8');
  const onDisk = Buffer.byteLength(text);

  const child = spawn(process.execPath, [BIN, '--root', workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
  const watcher = watchPeak(child);

  let stdout = '';
  const replies = [];
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    let index = stdout.indexOf('\n');
    while (index >= 0) {
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (line !== '') {
        try {
          replies.push(JSON.parse(line));
        } catch {
          replies.push({ unparseable: line.slice(0, 80) });
        }
      }
      index = stdout.indexOf('\n');
    }
  });

  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'm', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  send(2, 'tools/call', { name: 'notebook_read', arguments: { path: target, include_outputs: 'none' } });

  await new Promise((resolve) => setTimeout(resolve, 15_000));
  clearInterval(watcher.timer);
  reportSampleFailures(watcher.errors);
  const peakRss = watcher.peak;
  const readReply = replies.find((reply) => reply.id === 2);

  process.stdout.write(
    `${(onDisk / 1024 / 1024).toFixed(1).padStart(8)} | ${(peakRss / 1024 / 1024).toFixed(0).padStart(12)} | ${(peakRss / onDisk).toFixed(1).padStart(5)} | ${readReply === undefined ? 'no reply' : JSON.stringify(readReply).slice(0, 60)}\n`,
  );

  child.stdin.end();
  child.kill();
}

rmSync(workspace, { recursive: true, force: true });
