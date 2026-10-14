import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { IpynbError } from '../../src/core/errors.js';
import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import type { ExecCellParams, ExecCellResult, KernelTransport, StartKernelParams } from '../../src/kernel/transport.js';
import { createLogger } from '../../src/log.js';
import type { ToolContext } from '../../src/mcp/context.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { handleNotebookRun } from '../../src/mcp/tools/run.js';
import { createServer } from '../../src/server.js';

// Interpreter discovery is external to cancellation; the real server, run
// orchestration and registry remain in the test, without requiring Python.
vi.mock('../../src/kernel/interpreter.js', () => ({
  resolveForNotebook: async (input: { explicitPython: string | null }) => {
    if (input.explicitPython === 'missing') {
      throw new IpynbError('interpreter_not_found', 'test interpreter is unavailable', {});
    }
    return { interpreterPath: 'fake-python', kernelSpecName: 'python3', language: 'python', warnings: [] };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const CELL_RESULT: ExecCellResult = { status: 'ok', executionCount: 1, durationMs: 1, rawOutputs: [] };

class ControlledTransport implements KernelTransport {
  readonly alive = true;
  readonly started = deferred<void>();
  readonly interrupted = deferred<string>();
  readonly completion = deferred<ExecCellResult>();

  private nextResult = 0;
  constructor(private readonly waitForInterrupt = false, private readonly results: readonly ExecCellResult[] = []) {}

  async ping() { return { pythonVersion: '3.10', jupyterClientVersion: '8', ipykernelVersion: '6' }; }
  async startKernel(params: StartKernelParams) { return { pid: null, kernelSpecName: params.kernelSpecName, language: params.language }; }
  async execCell(params: ExecCellParams) {
    if (params.code !== 'x = 1') {
      throw new Error('unexpected cell source');
    }
    this.started.resolve();
    return this.waitForInterrupt ? this.completion.promise : this.results[this.nextResult++] ?? CELL_RESULT;
  }
  async interrupt(kernelId: string) {
    this.interrupted.resolve(kernelId);
    this.completion.resolve(CELL_RESULT);
  }
  async shutdownKernel() { this.completion.resolve(CELL_RESULT); }
  async kernelStatus() { return { alive: true, executionCount: 1, pid: null }; }
  async analyze() { return { ok: true, failedCellIndexes: [], defs: [], uses: [] }; }
  async shutdownAll() { this.completion.resolve(CELL_RESULT); }
  onKernelDied(callback: (kernelId: string) => void) { void callback; }
}

let workspace: string;
beforeAll(async () => { workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-cancellation-')); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

async function context(name: string, backend: ControlledTransport): Promise<{ ctx: ToolContext; notebook: string }> {
  const notebook = path.join(workspace, `${name}.ipynb`);
  await writeFile(notebook, JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{ id: 'c0', cell_type: 'code', metadata: {}, source: 'x = 1', execution_count: null, outputs: [] }],
  }));
  const config = parseConfig(['--root', workspace, '--artifact-dir', path.join(workspace, 'artifacts')], {}).config!;
  const registry = new KernelRegistry({ idleSeconds: 3600, transportFactory: () => backend });
  return { notebook, ctx: {
    config, registry, fence: new PathFence(workspace, false, process.platform),
    hasher, runStore: new RunStore(), logger: createLogger('error'), realpath: (target) => target, platform: process.platform,
  } };
}

describe('[I13] cancellation belongs to the request rather than progress reporting', () => {
  it('[U13] full mode ignores an invalid selector instead of trying to expand it', async () => {
    const { ctx, notebook } = await context('ignored-selector', new ControlledTransport());
    try {
      const outcome = await handleNotebookRun(ctx, { path: notebook, mode: 'full', cell_selector: 'not-a-selector', write_outputs: false });
      expect(outcome).toMatchObject({ payload: { kind: 'completed', mode_used: 'full', warnings: [{ code: 'targets_ignored' }] } });
    } finally {
      await ctx.registry.shutdownAll();
    }
  });

  it('[U26] does not materialize completed images in a failed run response', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
    const backend = new ControlledTransport(false, [
      { ...CELL_RESULT, rawOutputs: [{ outputType: 'display_data', data: { 'image/png': png.toString('base64') } }] },
      { status: 'timeout', executionCount: null, rawOutputs: [], durationMs: 1 },
    ]);
    const { ctx, notebook } = await context('failed-image', backend);
    await writeFile(notebook, JSON.stringify({
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [0, 1].map((index) => ({ id: `c${index}`, cell_type: 'code', metadata: {}, source: 'x = 1', execution_count: null, outputs: [] })),
    }));
    try {
      const outcome = await handleNotebookRun(ctx, { path: notebook, mode: 'full', write_outputs: false, timeout_seconds: 5 });
      expect(outcome).toMatchObject({ error: { code: 'exec_timeout' } });
      expect(existsSync(ctx.config.artifactDir)).toBe(false);
    } finally {
      await ctx.registry.shutdownAll();
    }
  });

  it.each([undefined, 'progress-1'])('[I13] reaches the live execution with progress token %s', async (token) => {
    const backend = new ControlledTransport(true);
    const { ctx, notebook } = await context(token ?? 'without-progress', backend);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'cancellation-test', version: '0.0.0' });
    await client.connect(clientTransport);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = client.callTool({
        name: 'notebook_run',
        arguments: { path: notebook, mode: 'full', write_outputs: false },
        ...(token === undefined ? {} : { _meta: { progressToken: token } }),
      }, undefined, { signal: controller.signal }).then(() => null, (cause: unknown) => cause);
      await backend.started.promise;
      controller.abort();
      const interruptedKernel = await Promise.race([
        backend.interrupted.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('server did not interrupt the execution')), 2000);
        }),
      ]);
      expect(interruptedKernel).toMatch(/^kernel-/);
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      clearTimeout(timer);
      backend.completion.resolve(CELL_RESULT);
      await client.close();
      await server.close();
      await ctx.registry.shutdownAll();
    }
  });

  it.each(['success', 'failure'])('[I13] removes abort listeners after synchronous %s', async (state) => {
    const { ctx, notebook } = await context(state, new ControlledTransport());
    const controller = new AbortController();
    try {
      const outcome = await handleNotebookRun({
        ...ctx, config: { ...ctx.config, python: state === 'failure' ? 'missing' : null },
      }, { path: notebook, mode: 'full', write_outputs: false }, { signal: controller.signal });
      expect('error' in outcome).toBe(state === 'failure');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await ctx.registry.shutdownAll();
    }
  });
});
