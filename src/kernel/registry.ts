// KernelRegistry (SPEC §5.3): the ONLY mutable cross-module state besides the
// run store. Reuse key = sha1(normalize(notebookAbs) + '|' + interpreter +
// '|' + kernelspec); one live kernel per key. Idle reclamation, busy locks
// (kernel_busy, no queuing) and generation counters live here.

import { createHash } from 'node:crypto';

import { IpynbError } from '../core/errors.js';
import { normalizeForCompare } from '../config.js';
import type { Logger } from '../log.js';
import { SidecarTransport, type SidecarTransportOptions } from './sidecar-transport.js';
import type { AnalyzeResult, ExecCellParams, ExecCellResult, KernelTransport } from './transport.js';

export interface KernelSessionInfo {
  readonly kernelId: string;
  readonly notebookPath: string;
  readonly interpreterPath: string;
  readonly kernelSpecName: string;
  readonly language: string;
  readonly alive: boolean;
  readonly startedAt: string;
  readonly lastUsedAt: string;
  readonly executionCount: number | null;
  readonly pid: number | null;
  readonly generation: number;
}

interface Session {
  readonly kernelId: string;
  readonly notebookPath: string;
  readonly interpreterPath: string;
  readonly kernelSpecName: string;
  readonly language: string;
  readonly startedAt: Date;
  lastUsedAt: Date;
  executionCount: number | null;
  pid: number | null;
  generation: number;
  busy: boolean;
  lastSeenContentHash: string | null;
  readonly transport: KernelTransport;
}

export interface RegistryOptions {
  readonly platform?: NodeJS.Platform;
  readonly idleSeconds: number;
  readonly logger?: Logger;
  readonly transportFactory?: (options: SidecarTransportOptions) => KernelTransport;
  readonly spawnImpl?: SidecarTransportOptions['spawnImpl'];
  readonly sidecarPath?: string;
  readonly now?: () => Date;
}

export class KernelRegistry {
  readonly #sessions = new Map<string, Session>(); // reuseKey -> session
  readonly #kernels = new Map<string, Session>(); // kernelId -> session
  readonly #transports = new Map<string, KernelTransport>(); // interpreter -> transport
  readonly #idleSeconds: number;
  readonly #logger?: Logger;
  readonly #platform: NodeJS.Platform;
  readonly #transportFactory: (options: SidecarTransportOptions) => KernelTransport;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;
  #nextKernelNumber = 1;

  constructor(options: RegistryOptions) {
    this.#idleSeconds = options.idleSeconds;
    this.#logger = options.logger;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    this.#transportFactory =
      options.transportFactory ??
      ((transportOptions: SidecarTransportOptions) => new SidecarTransport(transportOptions));
    this.#spawnOptionsExtras = options;
  }

  readonly #spawnOptionsExtras: RegistryOptions;

  /** Start the idle reclamation timer (interval: clamp(idle/2, 5..60) seconds). */
  start(): void {
    if (this.#timer !== null) {
      return;
    }
    const intervalSeconds = Math.max(5, Math.min(60, this.#idleSeconds / 2));
    this.#timer = setInterval(() => {
      void this.#reclaimIdle();
    }, intervalSeconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #reuseKey(notebookPath: string, interpreterPath: string, kernelSpecName: string): string {
    const normalized = normalizeForCompare(notebookPath, this.#platform);
    return createHash('sha1').update(`${normalized}|${interpreterPath}|${kernelSpecName}`).digest('hex');
  }

  /** Get the live session for a notebook path, if any. */
  findByNotebook(notebookPath: string): KernelSessionInfo | null {
    for (const session of this.#sessions.values()) {
      if (normalizeForCompare(session.notebookPath, this.#platform) === normalizeForCompare(notebookPath, this.#platform)) {
        return this.#toInfo(session);
      }
    }
    return null;
  }

  listKernels(): KernelSessionInfo[] {
    return [...this.#sessions.values()].map((session) => this.#toInfo(session));
  }

  /**
   * Return a live kernel for the notebook, starting one when the reuse key
   * has no live session. Concurrent starts for the same key share the promise.
   */
  async getOrCreate(input: {
    notebookPath: string;
    interpreterPath: string;
    kernelSpecName: string;
    language: string;
  }): Promise<KernelSessionInfo> {
    const key = this.#reuseKey(input.notebookPath, input.interpreterPath, input.kernelSpecName);
    const existing = this.#sessions.get(key);
    if (existing !== undefined && existing.transport.alive) {
      existing.lastUsedAt = this.#now();
      return this.#toInfo(existing);
    }
    if (existing !== undefined) {
      this.#removeSession(existing);
    }
    const kernelId = `kernel-${this.#nextKernelNumber}`;
    this.#nextKernelNumber += 1;

    const transport = this.#transportFor(input.interpreterPath);
    transport.onKernelDied((deadKernelId) => {
      this.#handleKernelDied(deadKernelId);
    });
    const result = await transport.startKernel({
      kernelId,
      interpreterPath: input.interpreterPath,
      kernelSpecName: input.kernelSpecName,
      language: input.language,
    });
    const session: Session = {
      kernelId,
      notebookPath: input.notebookPath,
      interpreterPath: input.interpreterPath,
      kernelSpecName: result.kernelSpecName,
      language: result.language,
      startedAt: this.#now(),
      lastUsedAt: this.#now(),
      executionCount: null,
      pid: result.pid,
      generation: 0,
      busy: false,
      lastSeenContentHash: null,
      transport,
    };
    this.#sessions.set(key, session);
    this.#kernels.set(kernelId, session);
    this.#logger?.info(`kernel started: ${kernelId} for ${input.notebookPath}`);
    return this.#toInfo(session);
  }

  #transportFor(interpreterPath: string): KernelTransport {
    const existing = this.#transports.get(interpreterPath);
    if (existing !== undefined && existing.alive) {
      return existing;
    }
    if (existing !== undefined) {
      this.#transports.delete(interpreterPath);
      // Kernels hosted by a dead sidecar are gone too.
      for (const session of Array.from(this.#sessions.values())) {
        if (session.transport === existing) {
          this.#removeSession(session);
        }
      }
    }
    const transport = this.#transportFactory({
      interpreterPath,
      onLog: (level, message) => {
        if (level === 'debug') {
          this.#logger?.debug(message);
        } else if (level === 'info') {
          this.#logger?.info(message);
        } else if (level === 'warn') {
          this.#logger?.warn(message);
        } else {
          this.#logger?.error(message);
        }
      },
      spawnImpl: this.#spawnOptionsExtras.spawnImpl,
      sidecarPath: this.#spawnOptionsExtras.sidecarPath,
      platform: this.#platform,
    });
    this.#transports.set(interpreterPath, transport);
    return transport;
  }

  /** Execute a cell on the notebook's kernel; kernel_busy when one is in flight. */
  async execCell(
    notebookPath: string,
    params: Omit<ExecCellParams, 'kernelId'>,
  ): Promise<{ result: ExecCellResult; session: KernelSessionInfo }> {
    const session = this.#requireSession(notebookPath, 'kernel_not_available');
    if (session.busy) {
      throw new IpynbError('kernel_busy', `kernel ${session.kernelId} is busy with an in-flight execution`, {
        kernel_id: session.kernelId,
      });
    }
    session.busy = true;
    try {
      const result = await session.transport.execCell({ ...params, kernelId: session.kernelId });
      session.lastUsedAt = this.#now();
      if (result.executionCount !== null) {
        session.executionCount = result.executionCount;
      }
      if (result.status === 'timeout') {
        // Timeout kills the kernel (SPEC §4.7 rule 6).
        await this.shutdown(notebookPath);
      }
      return { result, session: this.#toInfo(session) };
    } finally {
      session.busy = false;
    }
  }

  /** Run the sidecar's symtable analysis (SPEC §5.8 analyze op). */
  async analyze(notebookPath: string, sources: readonly string[]): Promise<AnalyzeResult> {
    const session = this.#requireSession(notebookPath, 'kernel_not_available');
    return session.transport.analyze(sources);
  }

  async interrupt(notebookPath: string): Promise<void> {
    const session = this.#requireSession(notebookPath, 'kernel_not_available');
    await session.transport.interrupt(session.kernelId);
  }

  async shutdown(notebookPath: string): Promise<void> {
    const session = this.#findSessionByNotebook(notebookPath);
    if (session === null) {
      return;
    }
    this.#removeSession(session);
    try {
      await session.transport.shutdownKernel(session.kernelId);
    } catch (cause) {
      this.#logger?.warn(`kernel shutdown reported failure for ${session.kernelId}: ${String(cause)}`);
    }
    this.#logger?.info(`kernel shutdown: ${session.kernelId}`);
  }

  async restart(notebookPath: string): Promise<KernelSessionInfo | null> {
    const session = this.#findSessionByNotebook(notebookPath);
    if (session === null) {
      return null;
    }
    const { interpreterPath, kernelSpecName, language } = session;
    await this.shutdown(notebookPath);
    return this.getOrCreate({ notebookPath, interpreterPath, kernelSpecName, language });
  }

  /** Last content hash observed for this notebook's kernel session, if any. */
  lastSeenContentHash(notebookPath: string): string | null {
    const session = this.#findSessionByNotebook(notebookPath);
    return session === null ? null : session.lastSeenContentHash;
  }

  /** Record the content hash the kernel's state currently reflects. */
  setLastSeenContentHash(notebookPath: string, contentHash: string | null): void {
    const session = this.#findSessionByNotebook(notebookPath);
    if (session !== null) {
      session.lastSeenContentHash = contentHash;
    }
  }

  /** Notify that the notebook was edited (bumps generation for stale analysis). */
  bumpGeneration(notebookPath: string): void {
    const session = this.#findSessionByNotebook(notebookPath);
    if (session !== null) {
      session.generation += 1;
    }
  }

  generationOf(notebookPath: string): number | null {
    const session = this.#findSessionByNotebook(notebookPath);
    return session === null ? null : session.generation;
  }

  async shutdownAll(): Promise<void> {
    this.stop();
    const sessions = Array.from(this.#sessions.values());
    this.#sessions.clear();
    this.#kernels.clear();
    for (const session of sessions) {
      try {
        await session.transport.shutdownKernel(session.kernelId);
      } catch (cause) {
        this.#logger?.warn(`kernel shutdown_all failure for ${session.kernelId}: ${String(cause)}`);
      }
    }
    const transports = Array.from(this.#transports.values());
    this.#transports.clear();
    for (const transport of transports) {
      try {
        await transport.shutdownAll();
      } catch (cause) {
        this.#logger?.warn(`sidecar shutdown failure: ${String(cause)}`);
      }
    }
    this.#logger?.info('all kernels and sidecars shut down');
  }

  #handleKernelDied(kernelId: string): void {
    const session = this.#kernels.get(kernelId);
    if (session !== undefined) {
      this.#removeSession(session);
      this.#logger?.warn(`kernel died unexpectedly: ${kernelId}`);
    }
  }

  #findSessionByNotebook(notebookPath: string): Session | null {
    const normalized = normalizeForCompare(notebookPath, this.#platform);
    for (const session of this.#sessions.values()) {
      if (normalizeForCompare(session.notebookPath, this.#platform) === normalized) {
        return session;
      }
    }
    return null;
  }

  #requireSession(notebookPath: string, errorCode: 'kernel_not_available' | 'kernel_died'): Session {
    const session = this.#findSessionByNotebook(notebookPath);
    if (session === null || !session.transport.alive) {
      throw new IpynbError(errorCode, `no live kernel for ${notebookPath}`, {
        path: notebookPath,
      });
    }
    return session;
  }

  #removeSession(session: Session): void {
    const key = this.#reuseKey(session.notebookPath, session.interpreterPath, session.kernelSpecName);
    if (this.#sessions.get(key) === session) {
      this.#sessions.delete(key);
    }
    if (this.#kernels.get(session.kernelId) === session) {
      this.#kernels.delete(session.kernelId);
    }
  }

  async #reclaimIdle(): Promise<void> {
    const now = this.#now().getTime();
    for (const session of Array.from(this.#sessions.values())) {
      const idleMs = now - session.lastUsedAt.getTime();
      if (idleMs >= this.#idleSeconds * 1000) {
        this.#logger?.info(`reclaiming idle kernel ${session.kernelId} (idle ${Math.round(idleMs / 1000)}s)`);
        await this.shutdown(session.notebookPath);
      }
    }
  }

  #toInfo(session: Session): KernelSessionInfo {
    return {
      kernelId: session.kernelId,
      notebookPath: session.notebookPath,
      interpreterPath: session.interpreterPath,
      kernelSpecName: session.kernelSpecName,
      language: session.language,
      alive: session.transport.alive,
      startedAt: session.startedAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      executionCount: session.executionCount,
      pid: session.pid,
      generation: session.generation,
    };
  }
}
