// Real-usage trial harness for ipynb-mcp.
//
// Not part of the package (scripts/ is not in `files`). Drives the LOCAL build
// (lib/bin.js) as a real stdio MCP client and exercises the six tools against
// real notebooks.
//
//   node scripts/trial-changejob.mjs --root <dir> --dump-tools
//   node scripts/trial-changejob.mjs --root <dir> --scan
//   node scripts/trial-changejob.mjs --root <dir> --scenario contract
//   node scripts/trial-changejob.mjs --root <dir> --scenario suite
//
// ========================== IT WRITES INTO --root ==========================
//
// The `suite` scenario EDITS notebooks in place: it inserts cells, rewrites markdown, and leaves
// `.bak` files behind. Point `--root` at a COPY, never at a directory you care about (review v13
// V13-3). The guard below refuses the known originals directory, but it cannot know about yours, so
// this warning is the real protection.
// ===========================================================================
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const root = flag('--root');
// This used to be one machine's Anaconda path. `--python` still wins when given; the fallback is the
// PATH's interpreter, because an absolute Windows literal is treated as a RELATIVE path anywhere else —
// every derived path was then wrong, and the `contract` scenario's "this must be refused" check passed
// for the wrong reason (review v13 V13-3③).
const python = flag('--python', process.env['IPYNB_TEST_PYTHON'] ?? 'python');
if (!root) {
  process.stderr.write('need --root\n');
  process.exit(2);
}

/**
 * Refuse the directory this harness must never modify.
 *
 * `scripts/trial-scenarios.mjs` names real notebooks from `E:\ChangeJob`, and running the suite against
 * that directory inserts cells into the user's real files, rewrites their markdown and leaves backups.
 * Resolved and case-folded first, because on Windows `E:\ChangeJob` and `e:\changejob\` are one place.
 */
const FORBIDDEN_ROOTS = ['E:\\ChangeJob', path.join(homedir(), 'ChangeJob')];
const resolvedRoot = path.resolve(root);
for (const forbidden of FORBIDDEN_ROOTS) {
  if (path.resolve(forbidden).toLowerCase() === resolvedRoot.toLowerCase()) {
    process.stderr.write(
      `refusing to run against ${forbidden}: this harness EDITS notebooks in place. Copy them first, e.g.\n` +
        `  robocopy "${forbidden}" "%TEMP%\\ipynb-trial\\nb" /E\n`,
    );
    process.exit(2);
  }
}

const heap = flag('--heap');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, 'lib', 'bin.js'), '--root', root, '--python', python],
  cwd: root,
  stderr: 'pipe',
  ...(heap ? { env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${heap}` } } : {}),
});
const client = new Client({ name: 'trial-changejob', version: '0.0.0' });
let stderrText = '';
transport.stderr?.on('data', (chunk) => {
  stderrText += chunk.toString('utf8');
});

await client.connect(transport);

const call = async (name, args) => {
  const t0 = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = (result.content ?? []).filter((b) => b.type === 'image');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { isError: result.isError === true, text, json, images, ms };
};

const note = (...a) => process.stdout.write(`${a.join(' ')}\n`);

if (has('--dump-tools')) {
  const { tools } = await client.listTools();
  for (const t of tools) process.stdout.write(`${t.name}  ::  ${(t.description ?? '').split('\n')[0]}\n`);
  await client.close();
  process.exit(0);
}

if (has('--scan')) {
  const names = ['20py.ipynb', 'simple-baseline-aai3100.ipynb', '便捷性.ipynb', 'hw2_solved.ipynb', 'coursework_base.ipynb'];
  for (const nb of names) {
    const r = await call('notebook_read', { path: nb, include_source: 'full', include_outputs: 'none' });
    process.stdout.write(`\n########## ${nb}  [${r.ms} ms] isError=${r.isError} cellKeys=${Object.keys(r.json?.cells?.[0] ?? {}).join(',')}\n`);
    for (const [i, c] of (r.json?.cells ?? []).entries()) {
      process.stdout.write(`  [${i}] ${c.cell_type} ${c.output_count ?? c.outputs_count ?? ''} (${String(c.source ?? '').length}ch) ${String(c.source ?? '').replace(/\n/g, ' | ').slice(0, 140)}\n`);
    }
  }
  await client.close();
  process.exit(0);
}

const scenario = flag('--scenario');
if (scenario) {
  const scen = (await import('./trial-scenarios.mjs')).default;
  const fn = scen[scenario];
  if (!fn) {
    process.stderr.write(`unknown scenario ${scenario}; have: ${Object.keys(scen).join(', ')}\n`);
    await client.close();
    process.exit(2);
  }
  const opts = {
    notebook: flag('--notebook'),
    probe: flag('--probe', 'plain'),
    write: flag('--write', 'true'),
    mode: flag('--mode'),
    kernelStart: flag('--kernel-start', 'true'),
    stderrLog: flag('--stderr-log'),
  };
  let failed = null;
  try {
    await fn({ call, note, root, client, opts });
  } catch (cause) {
    failed = cause;
    note(`\n!! scenario threw: ${String(cause)}`);
  }
  if (opts.stderrLog) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.stderrLog, stderrText, 'utf8');
    note(`\n--- full server stderr -> ${opts.stderrLog} (${stderrText.length} bytes)`);
  }
  note(`\n--- server stderr head:\n${stderrText.split('\n').slice(0, 12).join('\n')}`);
  note(`\n--- server stderr tail:\n${stderrText.split('\n').slice(-6).join('\n')}`);
  process.exit(failed ? 1 : 0);
}

await client.close();
process.stdout.write(stderrText.slice(0, 2000));
