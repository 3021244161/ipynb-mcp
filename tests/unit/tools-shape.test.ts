// U24 (D24): every tool returns exactly one text block (parseable JSON)
// plus 0..N image blocks; no structuredContent, no outputSchema declared.
// U27: schema-level violations (range/length/empty) raise invalid_arguments.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpynbConfig } from '../../src/config.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { PathFence } from '../../src/fs/fence.js';
import { createLogger } from '../../src/log.js';
import { createServer } from '../../src/server.js';

let workspace: string;
let client: Client;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-shape-'));
  const config: IpynbConfig = {
    root: workspace,
    allowOutsideRoot: false,
    readOnly: false,
    images: 'auto',
    // Point at a nonexistent interpreter: unit tests must never start kernels.
    python: path.join(workspace, 'no-such-python.exe'),
    kernelIdleSeconds: 3600,
    execTimeoutSeconds: 300,
    backgroundThresholdSeconds: 30,
    backupKeep: 10,
    artifactDir: path.join(workspace, 'artifacts'),
    inlineTextChars: 20000,
    previewLines: 12,
    maxImagesPerCall: 20,
    maxImageBytes: 20971520,
    logLevel: 'error',
  };
  const registry = new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') });
  const server = createServer({
    config,
    fence: new PathFence(workspace, false, process.platform),
    registry,
    runStore: new RunStore(),
    hasher,
    logger: createLogger('error'),
    realpath: (target) => realpathSync(target),
    platform: process.platform,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'shape-test', version: '0.0.0' });
  await client.connect(clientTransport);
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

interface ShapeResult {
  content?: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ShapeResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ShapeResult;
}

function assertSingleTextBlock(result: ShapeResult): string {
  expect(result.structuredContent).toBeUndefined();
  const blocks = result.content ?? [];
  const textBlocks = blocks.filter((block) => block.type === 'text');
  const imageBlocks = blocks.filter((block) => block.type === 'image');
  expect(textBlocks).toHaveLength(1);
  expect(blocks.length).toBe(textBlocks.length + imageBlocks.length);
  const text = String(textBlocks[0]!['text']);
  expect(() => JSON.parse(text)).not.toThrow();
  return text;
}

describe('[step9][U24] response shape across all six tools', () => {
  it('every tool answers with exactly one JSON text block', async () => {
    const nb = path.join(workspace, 'shape.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
    }));

    // 1. notebook_read: success shape.
    const read = await callTool('notebook_read', { path: nb });
    const readText = assertSingleTextBlock(read);
    expect(read.isError).toBeUndefined();
    expect(JSON.parse(readText)['cell_count']).toBe(1);

    // 2. notebook_edit: dry-run success shape.
    const edit = await callTool('notebook_edit', {
      path: nb,
      dry_run: true,
      ops: [{ op: 'replace_source', cell_index: 0, expected_source_hash: `sha256:${hasher.sha256Hex('x = 1')}`, new_text: 'x = 2' }],
    });
    const editText = assertSingleTextBlock(edit);
    expect(JSON.parse(editText)['applied']).toBe(1);

    // 3. notebook_run: the config points --python at a nonexistent path, and an
    // explicit interpreter failure is terminal (D23), so this is a
    // deterministic tool error — not a tautological either/or (review D5).
    const run = await callTool('notebook_run', { path: nb, cell_selector: 'all', timeout_seconds: 5 });
    const runText = assertSingleTextBlock(run);
    const runBody = JSON.parse(runText) as Record<string, unknown>;
    expect(runBody['code']).toBe('interpreter_not_found');

    // 4. notebook_run_status: unknown run — one block.
    const status = await callTool('notebook_run_status', { run_id: 'run-999' });
    const statusText = assertSingleTextBlock(status);
    expect(JSON.parse(statusText)['code']).toBe('run_not_found');

    // 5. notebook_run_cancel: unknown run — one block.
    const cancel = await callTool('notebook_run_cancel', { run_id: 'run-999' });
    assertSingleTextBlock(cancel);

    // 6. notebook_kernel status: success shape.
    const kernel = await callTool('notebook_kernel', { action: 'status' });
    const kernelText = assertSingleTextBlock(kernel);
    expect(JSON.parse(kernelText)['kernels']).toEqual([]);
  }, 120_000);

  it('declares no outputSchema for any tool', async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'notebook_edit',
      'notebook_kernel',
      'notebook_read',
      'notebook_run',
      'notebook_run_cancel',
      'notebook_run_status',
    ]);
    for (const tool of tools.tools) {
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  it('tool descriptions match SPEC §4.2 verbatim', async () => {
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool.description]));
    expect(byName.get('notebook_read')).toBe(
      "Read a Jupyter notebook: cell index, type, source and existing outputs. Set include_outputs='full' to get a cell's outputs including images.",
    );
    expect(byName.get('notebook_edit')).toBe(
      'Edit notebook cells. Every source change requires a compare-and-swap anchor (expected_source_hash or expected_text); a mismatch fails the whole request without writing.',
    );
    expect(byName.get('notebook_run')).toBe(
      "Execute notebook cells. mode='resume' runs only the target cells in the live kernel; 'replay' silently rebuilds state from cell 0 first; 'full' re-runs everything.",
    );
    expect(byName.get('notebook_run_status')).toBe('Poll a background notebook run started by notebook_run.');
    expect(byName.get('notebook_run_cancel')).toBe('Cancel a background notebook run started by notebook_run.');
    expect(byName.get('notebook_kernel')).toBe(
      'Inspect or manage the kernels held for notebooks: status, start, shutdown, restart.',
    );
  });
});

describe('[D-015] a default single-cell run stays SYNCHRONOUS (E1 regression)', () => {
  it('omitting timeout_seconds does not return a background handle', async () => {
    // SPEC D14's literal formula (300 x 1 > 30) sent EVERY default run to
    // background, contradicting §0. DEVIATIONS D-015 applies a conservative
    // factor; this guards the default-path behaviour.
    const nb = path.join(workspace, 'd15-default.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
    }));
    const result = await callTool('notebook_run', { path: nb });
    const body = JSON.parse(assertSingleTextBlock(result)) as Record<string, unknown>;
    // Synchronous: the call resolves to an outcome/error, never a run handle.
    expect(body['kind']).not.toBe('background');
    expect(body['run_id']).toBeUndefined();
    expect(body['code']).toBe('interpreter_not_found');
  }, 60_000);
});

describe('[D7] timeout_seconds boundary values are accepted (SPEC §4.5 range 1..86400)', () => {
  it('accepts 1 (synchronous) and 86400 (background), rejecting neither as invalid', async () => {
    const nb = path.join(workspace, 'd7-timeout.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
    }));

    // Lower bound 1: 1 x 1 cell stays under the background threshold, so the
    // run reaches interpreter resolution and fails there (the configured
    // interpreter does not exist) — proving 1 passed validation.
    const low = await callTool('notebook_run', { path: nb, timeout_seconds: 1 });
    const lowBody = JSON.parse(assertSingleTextBlock(low)) as Record<string, unknown>;
    expect(lowBody['code']).toBe('interpreter_not_found');

    // Upper bound 86400: far above the background threshold, so it must be
    // accepted AND take the background path — proving 86400 passed validation.
    const high = await callTool('notebook_run', { path: nb, timeout_seconds: 86400 });
    const highBody = JSON.parse(assertSingleTextBlock(high)) as Record<string, unknown>;
    expect(highBody['kind']).toBe('background');
    expect(highBody['run_id']).toBeDefined();
  }, 60_000);
});

describe('[step9][U27] schema-level violations raise invalid_arguments', () => {
  it('notebook_run timeout_seconds=0, notebook_edit 33 ops, notebook_read empty path', async () => {
    const nb = path.join(workspace, 'u27.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
    }));

    const runError = await callTool('notebook_run', { path: nb, timeout_seconds: 0 });
    expect(runError.isError).toBe(true);
    const runBody = JSON.parse(assertSingleTextBlock(runError));
    expect(runBody['code']).toBe('invalid_arguments');
    expect(String(runBody['detail']['field'])).toBe('timeout_seconds');

    const ops = Array.from({ length: 33 }, () => ({ op: 'clear_outputs', cell_index: 0 }));
    const editError = await callTool('notebook_edit', { path: nb, ops });
    const editBody = JSON.parse(assertSingleTextBlock(editError));
    expect(editBody['code']).toBe('invalid_arguments');
    expect(String(editBody['detail']['field'])).toBe('ops');

    const readError = await callTool('notebook_read', { path: '' });
    const readBody = JSON.parse(assertSingleTextBlock(readError));
    expect(readBody['code']).toBe('invalid_arguments');

    // NEW-2, resolved: an out-of-range ENUM VALUE must also be
    // `invalid_arguments`, not the SDK's -32602 protocol error. `mode` used to be
    // a schema `enum`, so the SDK answered before the handler ran and the model got
    // a protocol error instead of the documented code (review v4 NEW-2).
    const modeError = await callTool('notebook_run', { path: nb, mode: 'bogus' });
    expect(modeError.isError).toBe(true);
    const modeBody = JSON.parse(assertSingleTextBlock(modeError));
    expect(modeBody['code']).toBe('invalid_arguments');
    expect(String(modeBody['detail']['field'])).toBe('mode');
  }, 60_000);

  it('[ROB-5] cell_indexes is deduped and capped before rendering', async () => {
    const nb = path.join(workspace, 'rob5.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: Array.from({ length: 5 }, (_, i) => ({
        cell_type: 'code', id: `c${i}`, metadata: {}, source: `x = ${i}`, outputs: [], execution_count: null,
      })),
    }));

    // Repeating one index used to scale the RESPONSE with the ARGUMENT: 20 000
    // repeats produced a 5.6 MB text block from a 5-cell notebook (review v3
    // ROB-5). Dedup means the rendered cell count is what the caller asked for.
    const repeated = await callTool('notebook_read', { path: nb, cell_indexes: Array.from({ length: 200 }, () => 0) });
    const repeatedBody = JSON.parse(assertSingleTextBlock(repeated));
    expect((repeatedBody['cells'] as unknown[]).length).toBe(1);

    // Over the cap: rejected as an argument error, not silently truncated.
    const tooMany = await callTool('notebook_read', {
      path: nb,
      cell_indexes: Array.from({ length: 1001 }, (_, i) => i),
    });
    expect(tooMany.isError).toBe(true);
    const tooManyBody = JSON.parse(assertSingleTextBlock(tooMany));
    expect(tooManyBody['code']).toBe('invalid_arguments');
    expect(String(tooManyBody['detail']['field'])).toBe('cell_indexes');
  }, 60_000);

  it('[SEC-1] an unknown argument is rejected by the TOOL layer with invalid_arguments', async () => {
    const nb = path.join(workspace, 'sec1.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', id: 'c0', metadata: {}, source: 'x = 1', outputs: [], execution_count: null }],
    }));

    // `cell_selector` belongs to notebook_run (SPEC §4.1.11 keeps the two names
    // deliberately different). Sending it here used to read the whole notebook
    // with no error at all, because the SDK validated with a NON-strict object
    // and dropped the key before the handler could ever see it (review v3
    // SEC-1).
    //
    // The v3 fix made the SCHEMA strict, which made the request fail — but with
    // the SDK's protocol error, and it left the tool-layer whitelist
    // unreachable: reverting `rejectUnknownArguments` entirely kept the suite
    // green, i.e. the check that SPEC §4.1.12 actually names was dead code
    // (review v4 NEW-1). The schemas now pass unknown keys through, so this
    // asserts the code path that matters, with the code the SPEC names.
    const wrongArg = await callTool('notebook_read', { path: nb, cell_selector: '0' });
    const raw = String((wrongArg.content ?? [])[0]?.['text'] ?? '');
    expect(wrongArg.isError).toBe(true);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body['code']).toBe('invalid_arguments');
    expect(String((body['detail'] as Record<string, unknown>)['field'])).toBe('cell_selector');
    // It must NOT have silently read the notebook it was asked not to read.
    expect(raw).not.toContain('cell_count');

    // Mutation guard for the wiring itself: the tool layer is the ONLY layer
    // that can produce this detail, so if it stops being called this fails
    // rather than passing on the SDK's rejection.
    for (const [tool, args] of [
      ['notebook_read', { path: nb, bogus: 1 }],
      ['notebook_edit', { path: nb, ops: [{ op: 'clear_outputs', cell_index: 0 }], bogus: 1 }],
      ['notebook_run', { path: nb, mode: 'full', bogus: 1 }],
      ['notebook_run_status', { run_id: 'run-1', bogus: 1 }],
      ['notebook_run_cancel', { run_id: 'run-1', bogus: 1 }],
      ['notebook_kernel', { action: 'status', bogus: 1 }],
    ] as const) {
      const result = await callTool(tool, args as Record<string, unknown>);
      const resultBody = JSON.parse(String((result.content ?? [])[0]?.['text'] ?? '')) as Record<string, unknown>;
      expect(result.isError, `${tool} accepted an unknown argument`).toBe(true);
      expect(resultBody['code'], `${tool} did not use invalid_arguments`).toBe('invalid_arguments');
      expect(String((resultBody['detail'] as Record<string, unknown>)['reason'])).toContain('unknown argument');
    }
  }, 60_000);

  it('enum violations also raise invalid_arguments (not invalid_ops/internal)', async () => {
    const nb = path.join(workspace, 'u27b.ipynb');
    await writeFile(nb, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [],
    }));
    const result = await callTool('notebook_read', { path: nb, include_source: 'sometimes' });
    const body = JSON.parse(assertSingleTextBlock(result));
    expect(body['code']).toBe('invalid_arguments');
  });
});
