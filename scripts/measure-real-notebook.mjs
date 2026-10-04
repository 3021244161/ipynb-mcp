// Measure the server's peak memory on a REAL notebook the trial report used.
//
//   node scripts/measure-run-memory.mjs --file E:\tmp\ipynb-trial\nb\便捷性.ipynb
//
// The sizes matter for the decision: a guard needs the amplification factor, and "re-exec with a
// bigger heap" needs to know whether the default is close or far. Measured on the trial file, the
// number is what a user's own notebook produces rather than what a synthetic payload produces.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'lib', 'bin.js');
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}`;

/** Peak working set of the child, in bytes, sampled until it exits. */
function watchPeak(child, intervalMs = 100) {
  const state = { peak: 0, timer: null };
  const sample = () => {
    if (child.exitCode !== null || child.pid === undefined) {
      return;
    }
    try {
      const ps = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${String(child.pid)} -ErrorAction SilentlyContinue).PeakWorkingSet64`],
        { encoding: 'utf8' },
      );
      const value = Number(String(ps.stdout).trim());
      if (Number.isFinite(value) && value > state.peak) {
        state.peak = value;
      }
    } catch {
      // a sample that cannot be taken is not a failure
    }
  };
  sample();
  state.timer = setInterval(sample, intervalMs);
  return state;
}

/** One `tools/call` against a fresh server, reporting peak memory and the reply. */
async function measure(label, notebook, extraArgs = [], extraEnv = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'ipynb-mcp-mem-'));
  const target = path.join(workspace, 'case.ipynb');
  copyFileSync(notebook, target);
  const onDisk = statSync(target).size;

  const child = spawn(process.execPath, [...extraArgs, BIN, '--root', workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const watcher = watchPeak(child);
  let stdout = '';
  let stderr = '';
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
          replies.push({ unparseable: line.slice(0, 100) });
        }
      }
      index = stdout.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const send = (id, method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'm', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  send(2, 'tools/call', { name: 'notebook_read', arguments: { path: target, include_outputs: 'none' } });
  send(3, 'tools/call', { name: 'notebook_run', arguments: { path: target, cell_selector: '0', timeout_seconds: 120 } });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && replies.filter((reply) => reply.id === 3).length === 0 && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  clearInterval(watcher.timer);
  const runReply = replies.find((reply) => reply.id === 3);
  const crashed = child.exitCode !== null && runReply === undefined;
  process.stdout.write(
    `${label.padEnd(26)} file=${mib(onDisk).padStart(6)} MiB peak=${mib(watcher.peak).padStart(6)} MiB ratio=${(watcher.peak / onDisk).toFixed(1).padStart(5)} ` +
      `${crashed ? `CRASHED(exit=${String(child.exitCode)}) stderr=${stderr.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 90) ?? ''}` : `reply=${JSON.stringify(runReply).slice(0, 70)}`}\n`,
  );
  child.kill();
  rmSync(workspace, { recursive: true, force: true });
}

const fileIndex = process.argv.indexOf('--file');
if (fileIndex < 0) {
  process.stderr.write('usage: node scripts/measure-run-memory.mjs --file <notebook> [...]\n');
  process.exit(2);
}
for (const notebook of process.argv.slice(fileIndex + 1)) {
  await measure(path.basename(notebook), notebook);
}
