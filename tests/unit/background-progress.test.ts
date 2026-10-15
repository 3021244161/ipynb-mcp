import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { IpynbError } from '../../src/core/errors.js';
import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import type { ExecCellParams, ExecCellResult, KernelTransport, StartKernelParams } from '../../src/kernel/transport.js';
import { createLogger } from '../../src/log.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { createServer } from '../../src/server.js';

// Interpreter discovery is external to live snapshots; orchestration, storage,
// response budgeting and the consuming SDK remain real, with no Python needed.
vi.mock('../../src/kernel/interpreter.js', () => ({
  resolveForNotebook: async (input: { explicitPython: string | null }) => {
    if (input.explicitPython === 'missing') {
      throw new IpynbError('interpreter_not_found', 'test interpreter is unavailable');
    }
    return { interpreterPath: 'fake-python', kernelSpecName: 'python3', language: 'python', warnings: [] };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const OK: ExecCellResult = { status: 'ok', executionCount: 1, durationMs: 1, rawOutputs: [] };

class BlockedTransport implements KernelTransport {
  readonly alive = true;
  readonly bound = deferred<void>();
  readonly allowStart = deferred<void>();
  readonly secondStarted = deferred<void>();
  readonly releaseSecond = deferred<ExecCellResult>();
  constructor(private readonly first: ExecCellResult) {}
  async ping() { return { pythonVersion: '3.10', jupyterClientVersion: '8', ipykernelVersion: '6' }; }
  async startKernel(params: StartKernelParams) {
    this.bound.resolve();
    await this.allowStart.promise;
    return { pid: null, kernelSpecName: params.kernelSpecName, language: params.language };
  }
  async execCell(params: ExecCellParams) {
    if (params.code === 'first') {
      return this.first;
    }
    this.secondStarted.resolve();
    return this.releaseSecond.promise;
  }
  async interrupt() { this.releaseSecond.resolve({ ...OK, status: 'error', rawOutputs: [{ outputType: 'stream', name: 'stdout', text: 'unfinished output' }] }); }
  async shutdownKernel() { this.releaseSecond.resolve(OK); }
  async kernelStatus() { return { alive: true, executionCount: 1, pid: null }; }
  async analyze() { return { ok: true, failedCellIndexes: [], defs: [], uses: [] }; }
  async shutdownAll() { this.allowStart.resolve(); this.releaseSecond.resolve(OK); }
  onKernelDied(callback: (kernelId: string) => void) { void callback; }
}

describe('[U24][I16] background completed-cell visibility (#4)', () => {
  // Removing live publication recreates #4: progress advances but executed stays
  // empty. The blocked second cell makes that mutation fail deterministically.
  it.each([
    { status: 'ok', cancel: false, image: false }, { status: 'error', cancel: false, image: false },
    { status: 'ok', cancel: true, image: false }, { status: 'ok', cancel: false, image: true },
  ] as const)('publishes a completed $status cell while the next cell is blocked (cancel=$cancel, image=$image)', async ({ status, cancel, image }) => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-progress-'));
    const notebook = path.join(workspace, 'progress.ipynb');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
    const backend = new BlockedTransport({
      ...OK, status,
      rawOutputs: image
        ? [{ outputType: 'display_data', data: { 'image/png': png.toString('base64') }, metadata: {} }]
        : status === 'ok'
        ? Array.from({ length: 1000 }, () => ({ outputType: 'stream', name: 'stdout', text: '路径\\name\n'.repeat(20) }))
        : [{ outputType: 'error', ename: 'ValueError', evalue: 'intentional failure', traceback: ['ValueError: intentional failure'] }],
    });
    const config = { ...parseConfig(['--root', workspace, '--artifact-dir', path.join(workspace, 'artifacts')], {}).config!, backgroundThresholdSeconds: 0, maxResponseBytes: 32_768 };
    const registry = new KernelRegistry({ idleSeconds: 3600, transportFactory: () => backend });
    const runStore = new RunStore();
    const server = createServer({ config, registry, runStore, fence: new PathFence(workspace, false, process.platform), hasher, logger: createLogger('error'), realpath: (target) => target, platform: process.platform });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'progress-test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await writeFile(notebook, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: ['first', 'second'].map((source, index) => ({ id: `c${index}`, cell_type: 'code', metadata: {}, source, execution_count: null, outputs: [] })) }));
    const before = await readFile(notebook, 'utf8');
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }) as CallToolResult;
      const block = result.content[0];
      if (block?.type !== 'text') {
        throw new Error('missing text response');
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(config.maxResponseBytes);
      expect(result.structuredContent).toBeUndefined();
      return JSON.parse(block.text) as Record<string, unknown>;
    };
    let runId: string | undefined;
    try {
      const started = await call('notebook_run', { path: notebook, mode: 'full' });
      runId = String(started['run_id']);
      await backend.bound.promise;
      expect(await call('notebook_run_status', { run_id: runId })).toMatchObject({ kernel_id: null, executed: [] });
      backend.allowStart.resolve();
      await backend.secondStarted.promise;
      const cheap = await call('notebook_run_status', { run_id: runId, include_outputs: 'none' });
      expect(cheap['executed']).toEqual([expect.objectContaining({ cell_index: 0, status, outputs: [] })]);
      expect(existsSync(config.artifactDir)).toBe(false);
      const live = await call('notebook_run_status', { run_id: runId });
      expect(live['state']).toBe('running');
      expect(live['kernel_id']).toMatch(/^kernel-/);
      expect(live['progress'], JSON.stringify(live).slice(0, 1800)).toEqual({ completed: 1, total: 2, current_cell_index: 1 });
      expect(live['executed']).toEqual([expect.objectContaining({ cell_index: 0, status, execution_count: 1 })]);
      if (image) {
        const executed = live['executed'] as Array<{ outputs: Array<{ kind: string; image_index: number; artifact_path: string }> }>;
        expect(executed[0]!.outputs[0]).toMatchObject({ kind: 'image', image_index: 0 });
        expect(await readFile(executed[0]!.outputs[0]!.artifact_path)).toEqual(png);
      } else {
        expect(JSON.stringify(live['executed'])).toContain(status === 'error' ? 'intentional failure' : '路径');
      }
      expect(await readFile(notebook, 'utf8')).toBe(before);
      expect(await call('notebook_run_status', { run_id: runId })).toEqual(live);
      if (status === 'ok' && !cancel && !image) {
        try {
          await writeFile(notebook, '{invalid JSON');
          expect(await call('notebook_kernel', { path: notebook, action: 'restart' })).toMatchObject({ code: 'parse_failed' });
          expect(await call('notebook_run_status', { run_id: runId, include_outputs: 'none' })).toMatchObject({ state: 'running', error: null });
          await writeFile(notebook, before);
          config.python = 'missing';
          expect(await call('notebook_kernel', { path: notebook, action: 'restart' })).toMatchObject({ code: 'interpreter_not_found' });
          expect(await call('notebook_run_status', { run_id: runId, include_outputs: 'none' })).toMatchObject({ state: 'running', error: null });
        } finally {
          config.python = null;
          await writeFile(notebook, before);
        }
      }
      if (cancel) {
        expect(await call('notebook_run_cancel', { run_id: runId })).toMatchObject({ state: 'cancelled' });
      } else {
        backend.releaseSecond.resolve({ ...OK, executionCount: 2 });
      }
      await vi.waitFor(() => expect(runStore.get(runId!)?.finishedAt).not.toBeNull());
      const terminal = await call('notebook_run_status', { run_id: runId });
      expect(terminal).toMatchObject({ state: cancel ? 'cancelled' : 'completed', write_back: { performed: true }, facts_pending: false });
      if (cancel) {
        expect(terminal['executed']).toEqual([expect.objectContaining({ cell_index: 0, status })]);
        expect(JSON.stringify(terminal)).not.toContain('unfinished output');
      } else {
        expect(terminal['error']).toBeNull();
        expect(terminal['executed']).toEqual([expect.objectContaining({ cell_index: 0, status }), expect.objectContaining({ cell_index: 1, status: 'ok' })]);
      }
    } finally {
      backend.allowStart.resolve();
      backend.releaseSecond.resolve(OK);
      if (runId !== undefined) {
        await vi.waitFor(() => expect(runStore.get(runId!)?.finishedAt).not.toBeNull());
      }
      await client.close();
      await server.close();
      await registry.shutdownAll();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
