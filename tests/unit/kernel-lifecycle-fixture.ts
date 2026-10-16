import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, vi } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { PathFence } from '../../src/fs/fence.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import type { ExecCellParams, ExecCellResult, KernelTransport, StartKernelParams } from '../../src/kernel/transport.js';
import { createLogger } from '../../src/log.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { createServer } from '../../src/server.js';

// Discovery is external to lifecycle ordering; the registry, run orchestration,
// disk write-back and SDK consumer remain real without requiring Python.
vi.mock('../../src/kernel/interpreter.js', () => ({
  resolveForNotebook: async (_input: unknown, meta: { kernelSpecName: string }) => ({
    interpreterPath: meta.kernelSpecName, kernelSpecName: meta.kernelSpecName, language: 'python', warnings: [],
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const OK: ExecCellResult = { status: 'ok', executionCount: 1, durationMs: 1, rawOutputs: [] };

export class LifecycleTransport implements KernelTransport {
  readonly alive = true;
  readonly startEntered = deferred<void>();
  readonly allowStart = deferred<void>();
  readonly secondEntered = deferred<void>();
  readonly allowSecond = deferred<ExecCellResult>();
  readonly shutdownEntered = deferred<void>();
  readonly allowShutdown = deferred<void>();
  readonly executedKernelIds: string[] = [];
  readonly closedKernelIds: string[] = [];

  constructor(options: { blockStart?: boolean; blockShutdown?: boolean } = {}) {
    if (!options.blockStart) { this.allowStart.resolve(); }
    if (!options.blockShutdown) { this.allowShutdown.resolve(); }
  }
  async ping() { return { pythonVersion: '3.10', jupyterClientVersion: '8', ipykernelVersion: '6' }; }
  async startKernel(params: StartKernelParams) {
    this.startEntered.resolve();
    await this.allowStart.promise;
    return { pid: null, kernelSpecName: params.kernelSpecName, language: params.language };
  }
  async execCell(params: ExecCellParams): Promise<ExecCellResult> {
    this.executedKernelIds.push(params.kernelId);
    if (params.code === 'second') {
      this.secondEntered.resolve();
      return this.allowSecond.promise;
    }
    return { ...OK, rawOutputs: [{ outputType: 'stream', name: 'stdout', text: 'completed first cell' }] };
  }
  async interrupt() { /* Windows interrupts can leave the in-flight cell blocked. */ }
  async shutdownKernel(kernelId: string) {
    this.shutdownEntered.resolve();
    await this.allowShutdown.promise;
    this.closedKernelIds.push(kernelId);
    this.allowSecond.resolve({ ...OK, status: 'error', rawOutputs: [{ outputType: 'stream', name: 'stdout', text: 'partial second cell' }] });
  }
  async kernelStatus() { return { alive: true, executionCount: 1, pid: null }; }
  async analyze() { return { ok: true, failedCellIndexes: [], defs: [], uses: [] }; }
  async shutdownAll() { this.release(); }
  onKernelDied(callback: (kernelId: string) => void) { void callback; }
  release() { this.allowStart.resolve(); this.allowShutdown.resolve(); this.allowSecond.resolve(OK); }
}

export async function harness(sources: string[], transports: ReadonlyMap<string, LifecycleTransport>) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-lifecycle-'));
  const notebook = path.join(workspace, 'lifecycle.ipynb');
  const writeNotebook = async (spec: string) => writeFile(notebook, JSON.stringify({
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { name: spec, language: 'python', display_name: spec } },
    cells: sources.map((source, index) => ({ id: `c${index}`, cell_type: 'code', metadata: {}, source, execution_count: null, outputs: [] })),
  }));
  await writeNotebook('old-spec');
  const config = { ...parseConfig(['--root', workspace, '--artifact-dir', path.join(workspace, 'artifacts')], {}).config!, backgroundThresholdSeconds: 0 };
  const registry = new KernelRegistry({ idleSeconds: 3600, transportFactory: (options) => {
    const transport = transports.get(options.interpreterPath);
    if (transport === undefined) { throw new Error(`unexpected interpreter: ${options.interpreterPath}`); }
    return transport;
  } });
  const runStore = new RunStore();
  const server = createServer({ config, registry, runStore, fence: new PathFence(workspace, false, process.platform), hasher, logger: createLogger('error'), realpath: (target) => target, platform: process.platform });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lifecycle-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const block = result.content[0];
    if (block?.type !== 'text') { throw new Error('missing text response'); }
    return JSON.parse(block.text) as Record<string, unknown>;
  };
  const close = async () => {
    for (const transport of transports.values()) { transport.release(); }
    await client.close();
    await server.close();
    await registry.shutdownAll();
    await rm(workspace, { recursive: true, force: true });
  };
  return { notebook, writeNotebook, registry, runStore, call, close };
}
