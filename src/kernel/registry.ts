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
  /** Reuse key this session is stored under; recomputing it is lossy (a
   *  kernelspec name that resolves differently at start time would leak the
   *  session in #sessions forever). */
  readonly reuseKey: string;
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
  /**
   * Symlink-resolving canonicalizer for path identity (SPEC §5.3 defines the
   * reuse key as `realpath` + case folding). Defaults to identity, which keeps
   * unit tests hermetic; production passes `fs.realpathSync`.
   */
  readonly canonicalPath?: (target: string) => string;
}

export class KernelRegistry {
  readonly #sessions = new Map<string, Session>(); // reuseKey -> session
  readonly #kernels = new Map<string, Session>(); // kernelId -> session
  readonly #transports = new Map<string, KernelTransport>(); // interpreter -> transport
  readonly #starting = new Map<string, Promise<KernelSessionInfo>>(); // reuseKey -> in-flight start
  // Run-level locks keyed by NORMALIZED notebook path: a restart/fresh session
  // replaces the session object, so hanging the lock off the session let a
  // second run slip in with the first still in flight (review W5).
  readonly #runKeys = new Map<string, string>(); // normalized path -> reuseKey
  readonly #runActive = new Set<string>(); // reuseKeys with a whole run in flight
  /** normalized notebook path -> run abort sinks (see onRunAbort). */
  readonly #runAborts = new Map<string, Set<() => void>>();
  /**
   * notebook path (as spelled by a caller) -> resolved `realpath`. `#norm` runs
   * `realpathSync`, a real filesystem call, and every session lookup used to make
   * one call per session plus one for the query — so a run of N cells did N
   * synchronous stat chains on the hot path (review v4 NEW-4).
   *
   * The entry records the spelling it came from, and `#removeSession` drops
   * entries whose value resolves under that session's path. That matters because
   * a `realpath` answer is only valid while the filesystem agrees: a symlink
   * repointed between sessions would otherwise leave a stale mapping that can
   * make two different identities collide (review v5 MISC-3).
   */
  readonly #normCache = new Map<string, string>();
  readonly #idleSeconds: number;
  readonly #logger?: Logger;
  readonly #platform: NodeJS.Platform;
  readonly #transportFactory: (options: SidecarTransportOptions) => KernelTransport;
  readonly #now: () => Date;
  readonly #canonicalPath: (target: string) => string;
  #timer: NodeJS.Timeout | null = null;
  #nextKernelNumber = 1;

  constructor(options: RegistryOptions) {
    this.#idleSeconds = options.idleSeconds;
    this.#logger = options.logger;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    this.#canonicalPath = options.canonicalPath ?? ((target) => target);
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
      void this.reclaimIdle();
    }, intervalSeconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Path identity for reuse keys, run locks and lookups (SPEC §5.3):
   * `realpath` first, then case/separator folding on win32/darwin. Without the
   * realpath step the same file reached through a symlink/junction/`subst`
   * (`/tmp` -> `/private/tmp` on macOS) got its own kernel and its own run
   * lock, so two runs could interleave and only the write-back hash check
   * noticed (review v3 ROB-6). A path that cannot be resolved yet (the file is
   * about to be created) falls back to its own spelling.
   */
  #norm(notebookPath: string): string {
    const cached = this.#normCache.get(notebookPath);
    if (cached !== undefined) {
      return cached;
    }
    let canonical = notebookPath;
    try {
      canonical = this.#canonicalPath(notebookPath);
    } catch {
      // Unresolvable (missing/racing path): the literal spelling is all we have.
    }
    const normalized = normalizeForCompare(canonical, this.#platform);
    this.#normCache.set(notebookPath, normalized);
    return normalized;
  }

  #reuseKey(notebookPath: string, interpreterPath: string, kernelSpecName: string): string {
    const normalized = this.#norm(notebookPath);
    return createHash('sha1').update(`${normalized}|${interpreterPath}|${kernelSpecName}`).digest('hex');
  }

  /** Get the live session for a notebook path, if any. */
  findByNotebook(notebookPath: string): KernelSessionInfo | null {
    for (const session of this.#sessions.values()) {
      if (this.#norm(session.notebookPath) === this.#norm(notebookPath)) {
        return this.#toInfo(session);
      }
    }
    return null;
  }

  /**
   * Liveness for the SPEC §4.7 mode matrix, answered with a real kernel_status
   * probe: "the sidecar is up" outlives "the kernel is up" (a killed kernel
   * lingers until the sidecar's next request), so the session record alone
   * would pick `resume` for a kernel that is already gone.
   *
   * Returns the probed kernel id as well, so the caller can hand the answer
   * straight to `getOrCreate` instead of probing a second time (review v3
   * ROB-14: two probes could disagree and silently drift `resume` onto a fresh
   * kernel).
   */
  async liveKernel(notebookPath: string): Promise<{ kernelId: string } | null> {
    const session = this.#findSessionByNotebook(notebookPath);
    if (session === null || isTransportDead(session.transport)) {
      return null;
    }
    return (await this.#probeKernel(session)) ? { kernelId: session.kernelId } : null;
  }

  /** Convenience boolean form of {@link liveKernel}. */
  async hasLiveKernel(notebookPath: string): Promise<boolean> {
    return (await this.liveKernel(notebookPath)) !== null;
  }

  listKernels(): KernelSessionInfo[] {
    return [...this.#sessions.values()].map((session) => this.#toInfo(session));
  }

  /**
   * listKernels with the REAL kernel process state: transport.alive only says
   * the sidecar is up, so kernel status queries must ask the sidecar's
   * kernel_status op (review A18 — a killed/OOM kernel used to report
   * alive: true until the next exec).
   */
  async listKernelsWithStatus(): Promise<KernelSessionInfo[]> {
    // Broadcast concurrently: the queries share one sidecar, so this removes the
    // N-times round-trip QUEUEING delay rather than adding real parallelism
    // (review v3 PERF-4 — the old comment claimed "N x 15s of serial timeouts").
    return Promise.all(
      Array.from(this.#sessions.values()).map(async (session) => {
        const base = this.#toInfo(session);
        if (!base.alive) {
          return base;
        }
        try {
          const status = await session.transport.kernelStatus(session.kernelId);
          return {
            ...base,
            alive: status.alive,
            executionCount: status.executionCount ?? base.executionCount,
            pid: status.pid ?? base.pid,
          };
        } catch (cause) {
          // A failed query is NOT proof of death: reporting alive:false here
          // was indistinguishable from a confirmed dead kernel and the model
          // had no way to tell them apart (review W8). Keep the
          // transport-derived value — the warning-code list is closed
          // (SPEC §7), so a status-query failure has no code to carry.
          this.#logger?.warn(`kernel_status query failed for ${session.kernelId}: ${String(cause)}`);
          return base;
        }
      }),
    );
  }

  /**
   * Return a live kernel for the notebook, starting one when the reuse key
   * has no live session. Concurrent starts for the same key share the
   * in-flight promise (SPEC §5.3: one live kernel per key, no orphans).
   * `fresh: true` shuts down any existing session first — used by replay
   * mode, which must rebuild state on a NEW kernel (SPEC §4.7 matrix).
   */
  async getOrCreate(input: {
    notebookPath: string;
    interpreterPath: string;
    kernelSpecName: string;
    language: string;
    fresh?: boolean;
    /**
     * Liveness answer the caller already obtained (SPEC §4.7 mode selection
     * probes once). Passing it avoids a second sidecar round-trip per run and,
     * more importantly, the window in which the two answers could disagree and
     * silently turn a `resume` into "run on an empty kernel" (review v3 ROB-14).
     */
    knownAlive?: boolean;
  }): Promise<KernelSessionInfo> {
    const key = this.#reuseKey(input.notebookPath, input.interpreterPath, input.kernelSpecName);
    const existing = this.#sessions.get(key);
    if (existing !== undefined) {
      if (!existing.transport.alive) {
        // The sidecar backing this session is gone, so its kernel is gone with
        // it: there is nothing left to shut down. Dropping the session here is
        // what makes recovery work — routing this case through shutdown() threw
        // kernel_died on a dead transport and kept the session, so the notebook
        // could never run again in this process (review R1 / SPEC §5.3).
        this.#forgetTransport(existing.transport);
        this.#removeSession(existing);
        this.#logger?.warn(`dropped a session whose sidecar died: ${existing.kernelId}`);
      } else if (input.fresh === true) {
        await this.shutdown(input.notebookPath);
      } else if (input.knownAlive ?? (await this.#probeKernel(existing))) {
        existing.lastUsedAt = this.#now();
        return this.#toInfo(existing);
      } else {
        // The kernel process itself is gone (OOM / external kill) and only the
        // sidecar outlived it. Reusing the session would fail the run ~5s later
        // (the sidecar's iopub poll is what first notices) instead of rebuilding
        // here — SPEC §5.3: no live kernel means replay, not a failure.
        await this.#discardDeadKernel(existing);
      }
    }
    const inflight = this.#starting.get(key);
    if (inflight !== undefined) {
      return inflight;
    }
    const promise = this.#startNew(key, input).finally(() => {
      this.#starting.delete(key);
    });
    this.#starting.set(key, promise);
    return promise;
  }

  /** Real kernel process state, so a reused session is not already dead. */
  async #probeKernel(session: Session): Promise<boolean> {
    try {
      const status = await session.transport.kernelStatus(session.kernelId);
      return status.alive;
    } catch (cause) {
      // An unanswerable query is not proof of death: fall back to reuse and let
      // the run's own exec surface a real failure.
      this.#logger?.warn(`kernel_status probe failed for ${session.kernelId}: ${String(cause)}`);
      return true;
    }
  }

  /**
   * Retire a kernel the probe reported as dead. Asking the sidecar to shut it
   * down anyway keeps a wrong/unstable `alive:false` from orphaning a live
   * process — the same "forgotten but alive" shape ROB-2 fixes (review v3
   * ROB-13 / R19).
   */
  async #discardDeadKernel(session: Session): Promise<void> {
    try {
      await session.transport.shutdownKernel(session.kernelId);
    } catch (cause) {
      // Expected when the kernel really is gone; logged so a wedged sidecar is
      // still diagnosable.
      this.#logger?.warn(`cleanup of a kernel reported dead failed for ${session.kernelId}: ${String(cause)}`);
    } finally {
      this.#removeSession(session);
    }
    this.#logger?.warn(`dropped a session whose kernel died: ${session.kernelId}`);
  }

  async #startNew(
    key: string,
    input: {
      notebookPath: string;
      interpreterPath: string;
      kernelSpecName: string;
      language: string;
    },
  ): Promise<KernelSessionInfo> {
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
      reuseKey: key,
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
      // Kernels hosted by a dead sidecar are gone too.
      this.#forgetTransport(existing);
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
      // The sidecar owns the kernels: when its process dies, every session it
      // hosted is unreachable and must be dropped immediately, otherwise the
      // next getOrCreate finds a session it cannot shut down (review R1/V4).
      onExit: (reason) => {
        this.#logger?.warn(`sidecar for ${interpreterPath} is gone: ${reason}`);
        const hosted = Array.from(this.#sessions.values())
          .filter((session) => session.transport === transport)
          .map((session) => session.notebookPath);
        this.#forgetTransport(transport);
        for (const notebookPath of hosted) {
          this.#notifyRunAborted(notebookPath);
        }
      },
      spawnImpl: this.#spawnOptionsExtras.spawnImpl,
      sidecarPath: this.#spawnOptionsExtras.sidecarPath,
      platform: this.#platform,
      // SPEC §5.8: the sidecar (and the kernels it spawns) must inherit the
      // full parent environment — an env with only PYTHON* would strip PATH,
      // HOME and conda vars from every executed cell.
      env: process.env,
    });
    this.#transports.set(interpreterPath, transport);
    return transport;
  }

  /**
   * Acquire the run-level lock for a notebook (SPEC §10.2 I10): a second
   * concurrent notebook_run on the same kernel raises kernel_busy instead of
   * interleaving its cells with the first run's. The returned release
   * function must be called in a finally block.
   */
  acquireRun(notebookPath: string): () => void {
    const normalized = this.#norm(notebookPath);
    let key = this.#runKeys.get(normalized);
    if (key === undefined) {
      const session = this.#findSessionByNotebook(notebookPath);
      if (session === null) {
        throw new IpynbError('kernel_not_available', `no live kernel for ${notebookPath}`, {
          path: notebookPath,
        });
      }
      key = session.reuseKey;
    }
    if (this.#runActive.has(key)) {
      throw new IpynbError('kernel_busy', 'a run is already in flight on this notebook', {
        path: notebookPath,
      });
    }
    this.#runActive.add(key);
    this.#runKeys.set(normalized, key);
    return () => {
      this.#runActive.delete(key);
      if (this.#runKeys.get(normalized) === key) {
        this.#runKeys.delete(normalized);
      }
    };
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
    // Entering an execution counts as activity: a long cell must never look
    // idle to the reclamation timer (SPEC §5.3 "idle" semantics).
    session.lastUsedAt = this.#now();
    try {
      const result = await session.transport.execCell({ ...params, kernelId: session.kernelId });
      session.lastUsedAt = this.#now();
      if (result.executionCount !== null) {
        session.executionCount = result.executionCount;
      }
      if (result.status === 'timeout') {
        // SPEC §4.7 rule 6: a timed-out cell kills its kernel. Shut it down
        // FIRST — #removeSession before this call made shutdown() find no
        // session and return immediately, so the kernel process stayed alive
        // while the registry forgot it, and the next run started a SECOND live
        // kernel under the same reuse key (review v3 ROB-2 / SPEC §5.3, R19).
        try {
          await this.shutdown(notebookPath);
        } catch (shutdownCause) {
          // The timeout result is the primary outcome (review A30), but a
          // cleanup that cannot reach the sidecar still must not leave the
          // session pointing at a dead kernel.
          this.#logger?.warn(`post-timeout shutdown failed for ${session.kernelId}: ${String(shutdownCause)}`);
          this.#removeSession(session);
        }
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
    if (isTransportDead(session.transport)) {
      // Nothing to shut down: the sidecar that hosted this kernel is gone, so
      // the kernel is gone too. Treat it as cleaned up instead of turning a
      // maintenance operation into a permanent kernel_died (review R1/R2).
      this.#forgetTransport(session.transport);
      this.#removeSession(session);
      this.#logger?.info(`dropped a session with a dead sidecar: ${session.kernelId}`);
      return;
    }
    let failed = false;
    try {
      await session.transport.shutdownKernel(session.kernelId);
    } catch (cause) {
      // Keep the session registered so a retry (or the final shutdown_all)
      // can still reach this kernel — removing it first made the kernel
      // invisible-but-alive (review A30). This is not a dead end: the
      // dead-transport branch above covers the case where a retry cannot
      // work either, and this branch only fires while the sidecar is up.
      failed = true;
      this.#logger?.warn(`kernel shutdown failed for ${session.kernelId}; keeping the session for retry: ${String(cause)}`);
    }
    if (failed) {
      throw new IpynbError('kernel_died', `failed to shut down kernel ${session.kernelId}`, {
        kernel_id: session.kernelId,
      });
    }
    this.#removeSession(session);
    // Deliberately NOT notifying run sinks here: this branch is also the
    // session-replacement path (getOrCreate → fresh), where the very run doing
    // the replacing would abort itself before its first cell. Terminations the
    // run cannot observe arrive through #handleKernelDied / the sidecar exit
    // hook; a run whose in-flight exec hits a shutdown sees the rejection.
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
    // Every run dies with its kernel, and shutdown_all is the process-exit
    // path: runs must not keep waiting on kernels that are being torn down.
    const notebooks = new Set(sessions.map((session) => session.notebookPath));
    this.#runActive.clear();
    this.#runKeys.clear();
    for (const session of sessions) {
      try {
        await session.transport.shutdownKernel(session.kernelId);
      } catch (cause) {
        this.#logger?.warn(`kernel shutdown_all failure for ${session.kernelId}: ${String(cause)}`);
      }
    }
    for (const notebookPath of notebooks) {
      this.#notifyRunAborted(notebookPath);
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
    if (session === undefined) {
      return;
    }
    this.#removeSession(session);
    this.#logger?.warn(`kernel died unexpectedly: ${kernelId}`);
    // A run waiting on this kernel has to learn it is over HERE: its in-flight
    // exec fails with kernel_died either way, but cells that already completed
    // must still be written back and reported (SPEC §4.8 rule 3 / review R3).
    this.#notifyRunAborted(session.notebookPath);
  }

  /** Drop a transport and every session it hosts (the sidecar process is gone). */
  #forgetTransport(transport: KernelTransport): void {
    for (const [interpreterPath, candidate] of Array.from(this.#transports.entries())) {
      if (candidate === transport) {
        this.#transports.delete(interpreterPath);
      }
    }
    for (const session of Array.from(this.#sessions.values())) {
      if (session.transport === transport) {
        this.#removeSession(session);
      }
    }
  }

  /**
   * Register a run-level abort sink for a notebook. The registry owns the
   * kernel lifecycle, so it is the only layer that can tell a run waiting on
   * this kernel that the kernel is gone (SPEC §4.8 rule 1). Returns an
   * unregister function; the run calls it when it ends.
   *
   * Sinks fire only for terminations a run cannot observe on its own:
   * explicit shutdown/restart, idle reclamation, a sidecar exit and an
   * unexpected kernel death. `execCell`'s post-timeout cleanup deliberately
   * does NOT fire them — that death is the documented consequence of the
   * `timeout` result the caller already holds, and the run may continue with
   * the next cell (SPEC §4.7 rules 5/6).
   */
  onRunAbort(notebookPath: string, callback: () => void): () => void {
    const normalized = this.#norm(notebookPath);
    const sinks = this.#runAborts.get(normalized) ?? new Set<() => void>();
    sinks.add(callback);
    this.#runAborts.set(normalized, sinks);
    return () => {
      const current = this.#runAborts.get(normalized);
      if (current === undefined) {
        return;
      }
      current.delete(callback);
      if (current.size === 0) {
        this.#runAborts.delete(normalized);
      }
    };
  }

  /** Tell every run waiting on this notebook that its kernel terminated. */
  #notifyRunAborted(notebookPath: string): void {
    const sinks = this.#runAborts.get(this.#norm(notebookPath));
    if (sinks === undefined) {
      return;
    }
    for (const sink of Array.from(sinks)) {
      try {
        sink();
      } catch (cause) {
        this.#logger?.warn(`run abort sink failed for ${notebookPath}: ${String(cause)}`);
      }
    }
  }

  #findSessionByNotebook(notebookPath: string): Session | null {
    const normalized = this.#norm(notebookPath);
    for (const session of this.#sessions.values()) {
      if (this.#norm(session.notebookPath) === normalized) {
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
    if (this.#sessions.get(session.reuseKey) === session) {
      this.#sessions.delete(session.reuseKey);
    }
    if (this.#kernels.get(session.kernelId) === session) {
      this.#kernels.delete(session.kernelId);
    }
    // Drop the memoized realpath for THIS notebook. Matching on the normalized
    // value (rather than only the exact spelling the session used) also clears
    // the entries created by other spellings of the same file, so a repointed
    // symlink cannot leave a stale identity behind (review v5 MISC-3).
    const sessionNormalized = normalizeForCompare(session.notebookPath, this.#platform);
    for (const [spelling, normalized] of this.#normCache) {
      if (normalized === sessionNormalized || spelling === session.notebookPath) {
        this.#normCache.delete(spelling);
      }
    }
  }

  /**
   * Reclaim idle kernels. Called by the timer; also callable directly so a
   * test (or an operator) can drive reclamation deterministically instead of
   * sleeping through the interval.
   */
  async reclaimIdle(): Promise<void> {
    const now = this.#now().getTime();
    for (const session of Array.from(this.#sessions.values())) {
      if (session.busy) {
        // Never reclaim a kernel mid-execution (SPEC §5.3 "idle" semantics):
        // lastUsedAt only refreshes between cells, so a long-running cell
        // would otherwise look idle to this timer.
        continue;
      }
      const key = session.reuseKey;
      if (this.#runActive.has(key)) {
        // A whole run holds the notebook even while no cell is in flight (the
        // gap between cells): reclaiming then terminates that run.
        continue;
      }
      const idleMs = now - session.lastUsedAt.getTime();
      if (idleMs >= this.#idleSeconds * 1000) {
        this.#logger?.info(`reclaiming idle kernel ${session.kernelId} (idle ${Math.round(idleMs / 1000)}s)`);
        try {
          await this.shutdown(session.notebookPath);
        } catch (cause) {
          // Reclamation is maintenance: it runs from a void-ed timer callback,
          // so a rejection here had no handler and took the whole server down
          // with exit(2) (review R2). The session stays registered and the
          // next tick retries.
          this.#logger?.warn(`idle reclamation of ${session.kernelId} failed; will retry: ${String(cause)}`);
        }
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

/**
 * `alive` only says the sidecar process is up. A host killed between two
 * event-loop turns still has `exitCode === null` and `killed === false`, so a
 * request would be written into a dead pipe and fail — recovery must not
 * depend on catching that write (review R1).
 */
function isTransportDead(transport: KernelTransport): boolean {
  return transport.alive === false;
}
