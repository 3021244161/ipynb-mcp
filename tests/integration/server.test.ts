// Integration tests (step 9): server-level behaviors — stdout purity (I12),
// client abort of runs and edits (I13/I14), background run vs kernel
// restart (I16).

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { SIDECAR_REQUIRED_MODULES, pythonPrefix } from '../../src/kernel/interpreter.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { PathFence } from '../../src/fs/fence.js';
import { createLogger } from '../../src/log.js';
import { createServer } from '../../src/server.js';
import { BASE_PYTHON, prepareVenv } from './test-venv.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let workspace: string;
let client: Client;
let registry: KernelRegistry;
let previousJupyterPath: string | undefined;
let runStore: RunStore;

beforeAll(async () => {
  // ONE place builds, validates and falls back (review v8 V8-5).
  prepareVenv({ modules: SIDECAR_REQUIRED_MODULES });
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-server-'));
  const basePython = BASE_PYTHON === 'python' || BASE_PYTHON === 'python3' ? null : BASE_PYTHON;
  const jupyterRoot = basePython !== null ? path.join(pythonPrefix(basePython), 'share', 'jupyter') : null;
  // Save/restore so this file cannot leak the var into other test files in
  // the same worker (review D6: env pollution made cases order-dependent).
  previousJupyterPath = process.env['JUPYTER_PATH'];
  if (jupyterRoot !== null && existsSync(path.join(jupyterRoot, 'kernels'))) {
    process.env['JUPYTER_PATH'] = jupyterRoot;
  }
  registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') });
  registry.start();
  runStore = new RunStore();
  // A short exec timeout keeps the notebook_run cases quick; the background
  // decision still holds (30s x 5 cells > 30s threshold x 10).
  const config: IpynbConfig = configFor(workspace, 30);
  const server = createServer({
    config,
    fence: new PathFence(workspace, false, process.platform),
    registry,
    runStore,
    hasher,
    logger: createLogger('error'),
    realpath: (target) => realpathSync(target),
    platform: process.platform,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'server-test', version: '0.0.0' });
  await client.connect(clientTransport);
}, 180_000);

afterAll(async () => {
  // Restore the env var this file may have set (review D6).
  if (previousJupyterPath === undefined) {
    delete process.env['JUPYTER_PATH'];
  } else {
    process.env['JUPYTER_PATH'] = previousJupyterPath;
  }
  await registry.shutdownAll();
  await rm(workspace, { recursive: true, force: true });
}, 120_000);

async function writeNb(name: string, cells: Array<Record<string, unknown>>): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
    cells,
  }));
  return target;
}

function codeCell(id: string, source: string): Record<string, unknown> {
  return { cell_type: 'code', id, metadata: {}, source, outputs: [], execution_count: null };
}

/**
 * A cell carrying PRE-EXISTING outputs. Fixtures used to hardcode
 * `outputs: []`, which made "the run did not touch this cell" true by
 * construction and therefore blind to the A1 class of data loss (review T3).
 */
function seededCell(
  id: string,
  source: string,
  seed: { outputs?: unknown[]; execution_count?: number | null },
): Record<string, unknown> {
  return {
    cell_type: 'code',
    id,
    metadata: {},
    source,
    outputs: seed.outputs ?? [],
    execution_count: seed.execution_count ?? null,
  };
}

function streamOutput(text: string): Record<string, unknown> {
  return { output_type: 'stream', name: 'stdout', text: [text] };
}

function configFor(root: string, execTimeoutSeconds = 300): IpynbConfig {
  return {
    root,
    allowOutsideRoot: false,
    readOnly: false,
    images: 'auto',
    python: null,
    kernelIdleSeconds: 3600,
    execTimeoutSeconds,
    backgroundThresholdSeconds: 30,
    backupKeep: 10,
    artifactDir: path.join(root, 'artifacts'),
    inlineTextChars: 20000,
    previewLines: 12,
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    logLevel: 'error',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}> {
  return (await client.callTool({ name, arguments: args })) as unknown as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
}

describe('[I13] client abort of an in-flight synchronous run', () => {
  it('returns cancelled, interrupts the kernel and writes nothing new', async () => {
    const nb = await writeNb('i13.ipynb', [
      codeCell('c0', 'import time\ntime.sleep(30)'),
    ]);
    const before = await readFile(nb);

    const controller = new AbortController();
    const request = client.callTool(
      {
        name: 'notebook_run',
        arguments: { path: nb, cell_selector: 'all', timeout_seconds: 25 },
      },
      undefined,
      { signal: controller.signal },
    );
    // Let the run start, then cancel mid-cell.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    controller.abort();

    let result: { content: Array<{ type: string; text?: string }> } | null = null;
    let failure: unknown = null;
    try {
      result = (await request) as unknown as { content: Array<{ type: string; text?: string }> };
    } catch (cause) {
      failure = cause;
    }
    // Either the client surfaces the cancellation, or the server answers with
    // a cancelled tool error — both satisfy I13. What must NOT happen: the
    // cell runs to completion.
    if (result !== null) {
      const body = JSON.parse(String(result.content[0]?.text ?? '{}')) as Record<string, unknown>;
      expect(body['code']).toBe('cancelled');
    } else {
      // An assertion, not `expect(String(failure)).toBeTruthy()` — that form
      // passed for literally any throwable, including a TypeError (review T3).
      // The SDK surfaces an aborted request as its own MCP error, so the
      // message is checked for an abort/cancel shape rather than one wording.
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).toMatch(/abort|cancel/i);
    }

    // The kernel got interrupted well before the 30s sleep finished: the
    // file stays byte-identical (nothing executed to completion).
    expect(await readFile(nb)).toEqual(before);
  }, 120_000);
});

describe('[I14] client abort of an in-flight edit', () => {
  it('a genuinely in-flight abort leaves the file untouched with no tmp leftovers', async () => {
    // Review D4: the old case aborted BEFORE the request started (pre-aborted),
    // which is not "in-flight". Here the handler is entered first, then the
    // abort lands while the write path is running. The notebook is large
    // enough that the atomic write cannot finish within the same tick, so the
    // abort is deterministically observed mid-flight.
    const bigSource = `x = "${'y'.repeat(6_000_000)}"`;
    const nb = await writeNb('i14.ipynb', [codeCell('c0', bigSource)]);
    const before = await readFile(nb);

    const controller = new AbortController();
    const pending = handleEditThroughAbort(nb, controller.signal);
    // Abort on the next macrotask: after the handler's entry check, before or
    // during the atomic write.
    setTimeout(() => controller.abort(), 0);
    const outcome = await pending;

    expect(outcome).toMatchObject({ isError: true });
    const firstBlock = (outcome?.content ?? [])[0];
    const body = JSON.parse(firstBlock && 'text' in firstBlock ? firstBlock.text : '{}') as Record<string, unknown>;
    expect(body['code']).toBe('cancelled');

    // Nothing written, and no temp-file litter.
    expect(await readFile(nb)).toEqual(before);
    const leftovers = readdirSync(workspace).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  }, 120_000);

  it('a pre-aborted edit is also rejected without touching the file (fast path)', async () => {
    const nb = await writeNb('i14b.ipynb', [codeCell('c0', 'x = 1')]);
    const before = await readFile(nb);
    const controller = new AbortController();
    controller.abort();
    const outcome = await handleEditThroughAbort(nb, controller.signal);
    const firstBlock = (outcome?.content ?? [])[0];
    const body = JSON.parse(firstBlock && 'text' in firstBlock ? firstBlock.text : '{}') as Record<string, unknown>;
    expect(body['code']).toBe('cancelled');
    expect(await readFile(nb)).toEqual(before);
  }, 60_000);
});

async function handleEditThroughAbort(nb: string, signal: AbortSignal) {
  // Direct handler invocation with an already-aborted signal (the in-memory
  // client cannot inject a pre-cancelled request cleanly).
  const { handleNotebookEdit } = await import('../../src/mcp/tools/edit.js');
  const { toCallToolResult } = await import('../../src/mcp/tools/result.js');
  const { readNotebookFile } = await import('../../src/fs/notebook-file.js');
  const notebook = await readNotebookFile(nb, hasher);
  // Anchor against the notebook's ACTUAL first-cell source so the request
  // proceeds to the write path (the abort must land there, not at the CAS).
  const firstCell = notebook.cells[0];
  const currentSource = firstCell === undefined
    ? ''
    : Array.isArray(firstCell.source)
      ? (firstCell.source as string[]).join('')
      : String(firstCell.source);
  const sourceHash = `sha256:${hasher.sha256Hex(currentSource)}`;
  void notebook;
  const outcome = await handleNotebookEdit(
    {
      config: configFor(workspace),
      fence: new PathFence(workspace, false, process.platform),
      registry,
      runStore,
      hasher,
      logger: createLogger('error'),
      realpath: (target) => realpathSync(target),
      platform: process.platform,
    },
    {
      path: nb,
      ops: [{ op: 'replace_source', cell_index: 0, expected_source_hash: sourceHash, new_text: 'x = 2' }],
    },
    { signal },
  );
  return toCallToolResult(outcome);
}

describe('[I16] background run vs kernel restart', () => {
  it('fails the run immediately, writes completed cells, keeps status queryable', async () => {
    // Cells 2..4 carry SEEDED outputs, so "the run never touched them" is a
    // real claim instead of the empty fixture's tautology (review T3): a
    // clear_outputs_before that pre-cleared the whole target set, or a write
    // back that dropped untouched cells, now turns this case red.
    const nb = await writeNb('i16.ipynb', [
      codeCell('c0', 'a = 1'),
      codeCell('c1', 'b = 2'),
      seededCell('c2', 'import time\ntime.sleep(1)\nc = 3', {
        outputs: [streamOutput('STALE-C2\n')],
        execution_count: 71,
      }),
      seededCell('c3', 'import time\ntime.sleep(1)\nd = 4', {
        outputs: [streamOutput('STALE-C3\n')],
        execution_count: 72,
      }),
      seededCell('c4', 'e = 5', { outputs: [streamOutput('STALE-C4\n')], execution_count: 73 }),
    ]);
    const started = await callTool('notebook_run', {
      path: nb, cell_selector: 'all', timeout_seconds: 300,
    });
    const startBody = JSON.parse(String(started.content[0]?.text ?? '{}')) as Record<string, unknown>;
    expect(startBody['kind']).toBe('background');
    const runId = String(startBody['run_id']);

    // Wait until at least one cell completed (kernel startup can be slow
    // when files run serially); poll the run status instead of a fixed sleep.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const poll = await callTool('notebook_run_status', { run_id: runId });
      const pollBody = JSON.parse(String(poll.content[0]?.text ?? '{}')) as Record<string, unknown>;
      const progress = pollBody['progress'] as Record<string, unknown>;
      if (Number(progress?.['completed'] ?? 0) >= 2 || Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const restart = await callTool('notebook_kernel', { action: 'restart', path: nb });
    const restartBody = JSON.parse(String(restart.content[0]?.text ?? '{}')) as Record<string, unknown>;
    expect(restartBody['action']).toBe('restart');
    const newKernelId = String((restartBody['kernels'] as Array<Record<string, unknown>>)[0]?.['kernel_id'] ?? '');

    // The run must be queryable at every moment after the restart (no dangling
    // window) and immediately terminal.
    const statusAfterRestart = await callTool('notebook_run_status', { run_id: runId });
    const statusBody = JSON.parse(String(statusAfterRestart.content[0]?.text ?? '{}')) as Record<string, unknown>;
    // D4 excluded 'completed' here: a restart during an in-flight run cannot
    // legitimately end in success (review T3).
    expect(['failed', 'cancelled']).toContain(statusBody['state']);

    // Give the background task time to observe the abort and write back.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    const finalStatus = await callTool('notebook_run_status', { run_id: runId });
    const finalBody = JSON.parse(String(finalStatus.content[0]?.text ?? '{}')) as Record<string, unknown>;
    expect(finalBody['state']).toBe('failed');
    expect((finalBody['error'] as Record<string, unknown>)['code']).toBe('kernel_died');
    const writeBack = finalBody['write_back'] as Record<string, unknown>;
    expect(writeBack['performed']).toBe(true);

    // The file contains exactly the cells that COMPLETED before the restart:
    // a contiguous prefix 0..k-1, and every cell after them keeps its SEEDED
    // outputs and execution_count (SPEC §4.7 rule 3, §4.8 rule 2).
    const written = JSON.parse(await readFile(nb, 'utf8')) as { cells: Array<Record<string, unknown>> };
    const completedIndexes = written.cells
      .map((cell, index) => ({ index, count: cell['execution_count'] }))
      .filter((entry) => entry.count !== null && Number(entry.count) < 70)
      .map((entry) => entry.index);
    expect(completedIndexes.length).toBeGreaterThanOrEqual(1);
    expect(completedIndexes.length).toBeLessThan(5);
    // Contiguity from 0 — cells execute sequentially, so the completed set is
    // exactly {0, 1, …, k-1}.
    expect(completedIndexes).toEqual(
      Array.from({ length: completedIndexes.length }, (_, i) => i),
    );
    const seeds = [null, null, 71, 72, 73];
    for (let index = completedIndexes.length; index < written.cells.length; index += 1) {
      expect(written.cells[index]!['execution_count']).toBe(seeds[index]);
      expect(JSON.stringify(written.cells[index]!['outputs'])).toContain(`STALE-C${index}`);
    }
    // The failed run's status carries the same executed set (review D4).
    expect((finalBody['executed'] as unknown[]).length).toBe(completedIndexes.length);
    // Restart did not auto-run anything on the fresh kernel.
    expect(newKernelId).not.toBe('');
    const kernelStatus = await callTool('notebook_kernel', { action: 'status' });
    const kernels = JSON.parse(String(kernelStatus.content[0]?.text ?? '{}')) as { kernels: Array<Record<string, unknown>> };
    const fresh = kernels.kernels.find((k) => k['kernel_id'] === newKernelId);
    expect(fresh?.['execution_count']).toBeNull();
  }, 180_000);
});

describe('[I12] stdout purity of the real stdio server', () => {
  it('every stdout line from the spawned server is valid JSON-RPC', async () => {
    // Build first (lib/bin.js must exist); pnpm is a .cmd on Windows -> shell.
    const { execFileSync } = await import('node:child_process');
    if (!existsSync(path.join(REPO_ROOT, 'lib', 'bin.js'))) {
      execFileSync('pnpm build', { cwd: REPO_ROOT, stdio: 'ignore', timeout: 120_000, shell: true });
    }

    const serverWorkspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-stdio-'));
    const nbPath = path.join(serverWorkspace, 'nb.ipynb');
    await writeFile(nbPath, JSON.stringify({
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
    }));

    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'lib', 'bin.js'), '--root', serverWorkspace], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutLines: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') {
          stdoutLines.push(line);
        }
      }
    });
    let stderrText = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !predicate()) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!predicate()) {
        throw new Error('timed out waiting for server responses');
      }
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notebook_read', arguments: { path: nbPath } } });
    await waitFor(() => stdoutLines.filter((line) => line.includes('"id":3')).length >= 1, 30_000);

    // SPEC §10.2 I12 asks for stdout purity across a REAL workload, not just the
    // read path: an edit (backup + atomic write diagnostics) and a run (kernel
    // startup, sidecar stderr forwarding, progress notifications) are where a
    // stray console write would actually show up (review v3 TST-6).
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'notebook_edit',
        arguments: {
          path: nbPath,
          ops: [{ op: 'replace_source', cell_index: 0, expected_source_hash: `sha256:${hasher.sha256Hex('x = 1')}`, new_text: 'x = 2' }],
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'notebook_run', arguments: { path: nbPath, cell_selector: 'all', timeout_seconds: 60 } },
    });
    await waitFor(() => stdoutLines.filter((line) => line.includes('"id":5')).length >= 1, 120_000);

    child.stdin.end();
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      setTimeout(resolve, 10_000).unref?.();
    });

    // R14/I12: every stdout line parses as JSON; diagnostics only on stderr.
    // Five responses are expected now that the workload includes an edit and a
    // run, so a regression that silently drops frames is visible too.
    expect(stdoutLines.length).toBeGreaterThanOrEqual(5);
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // stderr must carry the diagnostics (review D4): the server logs its
    // startup line there, and NO log text may leak into stdout.
    expect(stderrText).toContain('[ipynb-mcp]');
    for (const line of stdoutLines) {
      expect(line).not.toContain('[ipynb-mcp]');
    }
    // Every stdout line is a well-formed JSON-RPC message.
    for (const line of stdoutLines) {
      const message = JSON.parse(line) as Record<string, unknown>;
      expect(message['jsonrpc']).toBe('2.0');
    }
    await rm(serverWorkspace, { recursive: true, force: true });
  }, 180_000);
});
