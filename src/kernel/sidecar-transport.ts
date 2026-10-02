// Sidecar transport (SPEC §5.8): spawns python/ipynb_sidecar.py, speaks
// NDJSON over stdio, correlates requests by uuid, forwards stderr as debug
// logs, and enforces the 64 MiB line cap (protocol error kills the sidecar).
// The spawn function is injectable for tests (I7/I11).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { IpynbError } from '../core/errors.js';
import {
  NdjsonFramer,
  ProtocolFramingError,
  parseSidecarMessage,
  type SidecarRequest,
} from './protocol.js';
import type {
  AnalyzeResult,
  ExecCellParams,
  ExecCellResult,
  KernelStatusResult,
  KernelTransport,
  PingResult,
  StartKernelParams,
  StartKernelResult,
} from './transport.js';

export type SpawnFn = typeof spawn;

export interface SidecarTransportOptions {
  readonly interpreterPath: string;
  /** defaults to the packaged python/ipynb_sidecar.py */
  readonly sidecarPath?: string;
  readonly onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly spawnImpl?: SpawnFn;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (cause: unknown) => void;
  timer: NodeJS.Timeout;
}

export class SidecarTransport implements KernelTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #framer = new NdjsonFramer();
  readonly #pending = new Map<string, Pending>();
  readonly #log: SidecarTransportOptions['onLog'];
  readonly #platform: NodeJS.Platform;
  #kernelDiedCallback: ((kernelId: string) => void) | null = null;
  #exited = false;
  #exitReason: string | null = null;

  constructor(options: SidecarTransportOptions) {
    this.#log = options.onLog;
    this.#platform = options.platform ?? process.platform;
    const sidecarPath =
      options.sidecarPath ?? fileURLToPath(new URL('../../python/ipynb_sidecar.py', import.meta.url));
    this.#child = (options.spawnImpl ?? spawn)(
      options.interpreterPath,
      ['-u', sidecarPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...options.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        detached: this.#platform !== 'win32',
      },
    ) as ChildProcessWithoutNullStreams;

    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#handleStdout(chunk);
    });
    this.#child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed !== '') {
          this.#log?.('debug', `sidecar: ${trimmed}`);
        }
      }
    });
    this.#child.on('exit', (code, signal) => {
      this.#exited = true;
      this.#exitReason = `sidecar exited (code=${String(code)}, signal=${String(signal)})`;
      this.#failAllPending('kernel_died', this.#exitReason);
    });
    this.#child.on('error', (cause) => {
      this.#exited = true;
      this.#exitReason = `sidecar spawn error: ${String(cause)}`;
      this.#failAllPending('kernel_died', this.#exitReason);
    });
  }

  get alive(): boolean {
    return !this.#exited && this.#child.exitCode === null && this.#child.killed === false;
  }

  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  onKernelDied(callback: (kernelId: string) => void): void {
    this.#kernelDiedCallback = callback;
  }

  async ping(): Promise<PingResult> {
    return this.#request('ping', {}, 30_000) as unknown as Promise<PingResult>;
  }

  async startKernel(params: StartKernelParams): Promise<StartKernelResult> {
    return this.#request('start_kernel', { ...params }, 120_000) as unknown as Promise<StartKernelResult>;
  }

  async execCell(params: ExecCellParams): Promise<ExecCellResult> {
    // Sidecar handles timeoutMs internally (interrupt + 5s grace); give it
    // headroom before the transport-level deadline fires.
    const transportTimeout = Math.max(params.timeoutMs + 30_000, 60_000);
    return this.#request('exec_cell', { ...params }, transportTimeout) as unknown as Promise<ExecCellResult>;
  }

  async interrupt(kernelId: string): Promise<void> {
    await this.#request('interrupt', { kernelId }, 15_000);
  }

  async shutdownKernel(kernelId: string): Promise<void> {
    await this.#request('shutdown_kernel', { kernelId }, 30_000);
  }

  async kernelStatus(kernelId: string): Promise<KernelStatusResult> {
    return this.#request('kernel_status', { kernelId }, 15_000) as unknown as Promise<KernelStatusResult>;
  }

  async analyze(sources: readonly string[]): Promise<AnalyzeResult> {
    return this.#request('analyze', { sources: [...sources] }, 60_000) as unknown as Promise<AnalyzeResult>;
  }

  async shutdownAll(): Promise<void> {
    if (this.#exited) {
      return;
    }
    try {
      await this.#request('shutdown_all', {}, 15_000);
    } catch (cause) {
      // Best effort: the kill path below still guarantees no orphans (R19),
      // but the failure must be observable (R7).
      this.#log?.('warn', `sidecar shutdown_all failed (kill path still guarantees no orphans): ${String(cause)}`);
    }
    await this.kill();
  }

  /** Hard kill: process group on POSIX, taskkill /T /F on Windows (SPEC §5.3). */
  async kill(): Promise<void> {
    if (this.#exited || this.#child.pid === undefined) {
      return;
    }
    await this.#killTree();
  }

  /** Reclaim the sidecar process tree regardless of the #exited flag. */
  async #killTree(): Promise<void> {
    const pid = this.#child.pid;
    if (pid === undefined) {
      return;
    }
    if (this.#platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (groupCause) {
        this.#log?.('warn', `process-group kill failed for sidecar ${pid}: ${String(groupCause)}`);
        try {
          this.#child.kill('SIGKILL');
        } catch (childCause) {
          this.#log?.('warn', `direct child kill failed for sidecar ${pid}: ${String(childCause)}`);
        }
      }
    }
    await this.#waitExit(5_000);
  }

  async #waitExit(timeoutMs: number): Promise<void> {
    if (this.#exited) {
      return;
    }
    await new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Timeouts must not leak the once-listener onto the child (A28).
        this.#child.removeListener('exit', onExit);
        resolve();
      }, timeoutMs);
      this.#child.once('exit', onExit);
    });
  }

  #handleStdout(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.#framer.push(chunk);
    } catch (cause) {
      if (cause instanceof ProtocolFramingError) {
        this.#log?.('error', cause.message);
        this.#failAllPending('kernel_died', cause.message);
        void this.kill();
        return;
      }
      throw cause;
    }
    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }
      const message = parseSidecarMessage(line);
      if (message === null) {
        this.#log?.('warn', `sidecar sent an unparseable line (${line.length} chars)`);
        continue;
      }
      if ('id' in message && typeof message.id === 'string') {
        this.#dispatchResponse(message.id, message);
      } else if ('event' in message) {
        this.#dispatchEvent(message);
      }
    }
  }

  #dispatchResponse(id: string, message: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string; detail?: string } }): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#log?.('warn', `sidecar response for unknown request id: ${id}`);
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result ?? {});
    } else {
      const error = message.error ?? { code: 'internal', message: 'unknown sidecar error' };
      pending.reject(
        new IpynbError(
          this.#mapSidecarCode(error.code),
          `sidecar: ${error.message}`,
          error.detail === undefined ? {} : { detail: error.detail },
        ),
      );
    }
  }

  #dispatchEvent(message: { event: string; kernelId?: string; level?: string; message?: string }): void {
    if (message.event === 'kernel_died' && typeof message.kernelId === 'string') {
      this.#log?.('warn', `kernel died: ${message.kernelId}`);
      this.#kernelDiedCallback?.(message.kernelId);
      return;
    }
    if (message.event === 'log') {
      const level = message.level === 'warn' || message.level === 'error' ? message.level : 'debug';
      this.#log?.(level, `sidecar: ${message.message ?? ''}`);
    }
  }

  #request(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.#exited) {
      return Promise.reject(new IpynbError('kernel_died', this.#exitReason ?? 'sidecar is not running'));
    }
    const request: SidecarRequest = { id: randomUUID(), op, params };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(new IpynbError('kernel_died', `sidecar request timed out after ${timeoutMs}ms (op=${op})`));
      }, timeoutMs);
      this.#pending.set(request.id, { resolve, reject, timer });
      try {
        this.#child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (cause) {
        this.#pending.delete(request.id);
        clearTimeout(timer);
        reject(new IpynbError('kernel_died', `cannot write to sidecar stdin: ${String(cause)}`));
      }
    });
  }

  #failAllPending(code: 'kernel_died', reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new IpynbError(code, reason));
    }
  }

  #mapSidecarCode(code: string): 'kernel_died' | 'kernel_busy' | 'internal' {
    if (code === 'kernel_died' || code === 'kernel_busy') {
      return code;
    }
    return 'internal';
  }
}
