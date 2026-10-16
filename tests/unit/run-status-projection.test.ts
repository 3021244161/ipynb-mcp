import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { createLogger } from '../../src/log.js';
import { RunStore } from '../../src/mcp/run-store.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { finalizeToolResult } from '../../src/mcp/tools/result.js';
import { handleRunStatus } from '../../src/mcp/tools/run-status.js';
import { createServer } from '../../src/server.js';

async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-status-'));
  const config = parseConfig(['--root', workspace, '--artifact-dir', path.join(workspace, 'artifacts')], {}).config!;
  const registry = new KernelRegistry({ idleSeconds: 3600 });
  const runStore = new RunStore();
  const handle = runStore.create(path.join(workspace, 'nb.ipynb'), 250);
  handle.kernelId = 'kernel-1';
  handle.progress = { completed: 250, total: 250, currentCellIndex: 249 };
  handle.executed = Array.from({ length: 250 }, (_, cell_index) => ({
    cell_index, cell_id: `c${cell_index}`, status: cell_index === 3 ? 'error' as const : 'ok' as const,
    duration_ms: 1, execution_count: cell_index + 1,
    outputs: [{ kind: 'stream' as const, stream_name: 'stdout' as const, text: '路径\\name\n'.repeat(100), truncated: false, truncated_at_chars: null }],
  }));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
  const artifact = path.join(config.artifactDir, 'checkpoint.png');
  handle.executed[0]!.outputs.push({ kind: 'image', media_type: 'image/png', width: 1, height: 1, bytes: png.length, artifact_path: artifact, image_index: 0, text_fallback: 'checkpoint image' });
  handle.imageBlocks = [{ data: png.toString('base64'), media_type: 'image/png' }];
  handle.imageArtifacts = [{ imageIndex: 0, artifactPath: artifact, base64: png.toString('base64') }];
  const ctx: ToolContext = { config, registry, runStore, fence: new PathFence(workspace, false, process.platform), hasher, logger: createLogger('error'), realpath: (target) => target, platform: process.platform };
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'status-projection-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { ctx, config, handle, artifact, png, client, call: async (args: Record<string, unknown>, name = 'notebook_run_status') => {
    const result = await client.callTool({ name, arguments: { run_id: handle.runId, ...args } }) as CallToolResult;
    const text = result.content[0];
    if (text?.type !== 'text') {
      throw new Error('missing text result');
    }
    expect(result.structuredContent).toBeUndefined();
    return { result, body: JSON.parse(text.text) as Record<string, unknown> };
  }, close: async () => { await client.close(); await server.close(); await registry.shutdownAll(); await rm(workspace, { recursive: true, force: true }); } };
}

// Returning stored outputs in the cheap projection fails both the size bound
// and the no-artifact assertion; mutating them fails the later full retrieval.
it.each(['running', 'completed', 'failed', 'cancelled'] as const)('[U24][U26] cheap %s polling preserves cell failures and withholds images (#6)', async (state) => {
  const f = await fixture();
  f.handle.state = state;
  f.handle.writeBack = { performed: state === 'completed', backupPath: null };
  f.handle.error = state === 'failed' ? { code: 'kernel_died', message: 'kernel died' } : null;
  try {
    const before = JSON.stringify(f.handle.executed);
    const { result, body } = await f.call({ include_outputs: 'none' });
    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(40_000);
    expect(body).toMatchObject({ state, progress: { completed: 250 }, write_back: { performed: state === 'completed' }, error: f.handle.error });
    const executed = body['executed'] as Array<{ cell_index: number; status: string; outputs: unknown[] }>;
    expect(executed).toHaveLength(250);
    expect(executed.filter((cell) => cell.status === 'error').map((cell) => cell.cell_index)).toEqual([3]);
    expect(executed.every((cell) => cell.outputs.length === 0)).toBe(true);
    expect(body['warnings']).toEqual([]);
    expect(existsSync(f.config.artifactDir)).toBe(false);
    expect(JSON.stringify(f.handle.executed)).toBe(before);
    expect((await f.call({ include_outputs: 'none' })).body).toEqual(body);
    const full = await f.call({});
    expect(full.result.content).toHaveLength(2);
    expect(full.body['executed']).toEqual(f.handle.executed);
    expect(await readFile(f.artifact)).toEqual(f.png);
    expect((await f.call({ include_outputs: 'full' })).body).toEqual(full.body);
  } finally {
    await f.close();
  }
});

it.each(['full', 'none'] as const)('[U24][U26] captures coherent %s facts before another cell completes', async (include_outputs) => {
  const f = await fixture();
  try {
    // runTool awaits the captured outcome before the server formats it. A
    // background completion in that gap must not extend only executed while
    // leaving progress and image plans at their previously captured values.
    const pending = handleRunStatus(f.ctx, { run_id: f.handle.runId, include_outputs });
    const laterArtifact = path.join(f.config.artifactDir, 'later.png');
    f.handle.executed.push({ cell_index: 250, cell_id: 'later', status: 'ok', execution_count: 251, duration_ms: 1, outputs: [{ kind: 'image', media_type: 'image/png', width: 1, height: 1, bytes: f.png.length, artifact_path: laterArtifact, image_index: 1, text_fallback: '' }] });
    f.handle.progress.completed = 251;
    f.handle.imageBlocks = [...f.handle.imageBlocks, { data: f.png.toString('base64'), media_type: 'image/png' }];
    f.handle.imageArtifacts = [...f.handle.imageArtifacts, { imageIndex: 1, artifactPath: laterArtifact, base64: f.png.toString('base64') }];
    const result = await finalizeToolResult(await pending, { maxResponseBytes: f.config.maxResponseBytes });
    const text = result.content[0];
    if (text?.type !== 'text') {
      throw new Error('missing text result');
    }
    const body = JSON.parse(text.text) as Record<string, unknown>;
    expect(body).toMatchObject({ progress: { completed: 250 } });
    expect(body['executed']).toHaveLength(250);
    expect(result.content).toHaveLength(include_outputs === 'full' ? 2 : 1);
    expect(existsSync(laterArtifact)).toBe(false);
    expect(f.handle.executed).toHaveLength(251);
  } finally {
    await f.close();
  }
});

it('[U27] validates output detail and keeps cancel arguments unchanged', async () => {
  const f = await fixture();
  try {
    const tools = await f.client.listTools();
    expect(tools.tools.find((tool) => tool.name === 'notebook_run_status')?.inputSchema.properties).toHaveProperty('include_outputs');
    const invalid = await f.call({ include_outputs: 'summary' });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.body).toMatchObject({ code: 'invalid_arguments' });
    const cancel = await f.call({ include_outputs: 'none' }, 'notebook_run_cancel');
    expect(cancel.body).toMatchObject({ code: 'invalid_arguments' });
  } finally {
    await f.close();
  }
});
