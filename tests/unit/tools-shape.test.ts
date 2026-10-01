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
      metadata: { kernelspec: { name: 'python3' }, language_info: { name: 'python' } },
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

    // 3. notebook_run: background handle or interpreter failure — one block either way.
    const run = await callTool('notebook_run', { path: nb, cell_selector: 'all', timeout_seconds: 5 });
    const runText = assertSingleTextBlock(run);
    const runBody = JSON.parse(runText) as Record<string, unknown>;
    expect(runBody['kind'] === 'background' || runBody['code'] !== undefined).toBe(true);

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
