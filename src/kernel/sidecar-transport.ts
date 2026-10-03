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
  isSidecarResponse,
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

/**
 * The sidecar's own worst-case budget for a cell that never becomes idle
 * (python/ipynb_sidecar.py): interrupt, then wait for the interrupt to land.
 * A transport margin SMALLER than this makes the transport give up first and
 * rewrite the documented `exec_timeout` into `kernel_died` (review v3 ROB-11).
 *
 * There is deliberately no shell-reply term. The sidecar used to wait up to
 * 30 s for `execute_reply` after a timeout, which is dead time by construction:
 * the kernel is still running the cell, so the reply cannot arrive. That made
 * the "worst case" the NORMAL case — a 3 s timeout cost 38 s on Windows, where
 * `interrupt_kernel()` needs a console the MCP server does not have (review v4
 * FID-6). The sidecar now returns the timeout immediately, so this budget is
 * what actually bounds it; keep the two in sync when either side changes.
 */
const SIDECAR_INTERRUPT_GRACE_MS = 5_000;
/**
 * Mirror of SHELL_REPLY_BUDGET_SECONDS in python/ipynb_sidecar.py: the wait for
 * an execute_reply after iopub went idle. It is NOT part of the timeout path
 * any more (that path returns immediately, see above) but it still bounds how
 * long a normal cell may take to report, so the transport budgets above it.
 */
const SIDECAR_SHELL_REPLY_MS = 30_000;
const SIDECAR_WORST_CASE_MS = SIDECAR_INTERRUPT_GRACE_MS;

/** How many trailing stderr lines travel with a kernel_died error. */
const STDERR_TAIL_LINES = 20;

/**
 * What to do with the sidecar process when a request never answers.
 * `wait` — the sidecar is merely busy on another op or is composing a large
 * reply; killing it would take down every kernel on this interpreter (which is
 * exactly what a timeout of `kernel_status`/`analyze` must not do).
 * `reclaim` — the sidecar owns the deadline for this op and still missed it, so
 * the process tree is wedged and gets reclaimed.
 */
type TimeoutAction = 'wait' | 'reclaim';

export interface SidecarTransportOptions {
  readonly interpreterPath: string;
  /** defaults to the packaged python/ipynb_sidecar.py */
  readonly sidecarPath?: string;
  readonly onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly spawnImpl?: SpawnFn;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Fired once when the sidecar process is gone (exit, spawn error or a stdio
   * error). The registry uses it to drop the sessions this transport hosted,
   * so a crashed sidecar cannot leave a notebook permanently unrunnable
   * (review R1/R2/V4).
   */
  readonly onExit?: (reason: string) => void;
  /** How long a reclaim waits for the sidecar to actually die (default 5s). */
  readonly killGraceMs?: number;
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
  readonly #onExit: ((reason: string) => void) | undefined;
  readonly #killGraceMs: number;
  /** Ring buffer of the sidecar's most recent stderr lines (review v3 ROB-10). */
  readonly #stderrTail: string[] = [];
  #kernelDiedCallback: ((kernelId: string) => void) | null = null;
  #exited = false;
  #exitReason: string | null = null;
  #exitNotified = false;
  #reclaiming = false;

  constructor(options: SidecarTransportOptions) {
    this.#log = options.onLog;
    this.#platform = options.platform ?? process.platform;
    this.#onExit = options.onExit;
    this.#killGraceMs = options.killGraceMs ?? 5_000;
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
    // Every one of the three stdio streams can fail on its own. Without an
    // 'error' listener a stdin EPIPE/EOF escalates into an uncaughtException —
    // which the fatal hook turns into process exit instead of a kernel_died
    // result (review V1/A20).
    this.#child.stdout.on('error', (cause) => this.#failTransport(`sidecar stdout error: ${String(cause)}`));
    this.#child.stdin.on('error', (cause) => this.#failTransport(`sidecar stdin error: ${String(cause)}`));
    this.#child.stderr.on('error', (cause) => this.#failTransport(`sidecar stderr error: ${String(cause)}`));
    this.#child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed !== '') {
          this.#stderrTail.push(trimmed);
          if (this.#stderrTail.length > STDERR_TAIL_LINES) {
            this.#stderrTail.shift();
          }
          // `warn`, not `debug`: an interpreter that cannot boot a kernel
          // (broken pyzmq, missing shared library) reports it HERE and nowhere
          // else, and the model's error carries only the exit code
          // (review v3 ROB-10).
          this.#log?.('warn', `sidecar: ${trimmed}`);
        }
      }
    });
    this.#child.on('exit', (code, signal) => {
      this.#failTransport(`sidecar exited (${describeExit(code, signal)})`);
    });
    this.#child.on('error', (cause) => {
      this.#failTransport(`sidecar spawn error: ${String(cause)}`);
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
    // The sidecar's worst case for a cell that times out is `timeoutMs + the
    // interrupt grace`: it interrupts, then waits that long for the interrupt to
    // land. There is no shell-reply term — the sidecar returns the timeout
    // immediately instead of waiting for a reply a still-running cell cannot send
    // (review v4 FID-6, D-033). A margin SMALLER than the real worst case makes
    // the transport give up first, which turns the documented `exec_timeout` into
    // `kernel_died` and tears down every kernel on this sidecar (review v3
    // ROB-11).
    // INVARIANT: transportTimeout > max(SIDECAR_WORST_CASE_MS, SIDECAR_SHELL_REPLY_MS) + slack.
    // The shell-reply budget matters even though the timeout path no longer waits
    // for a reply: a NORMAL cell still takes up to that long to report, and the
    // transport must not give up inside a legitimate execution.
    const transportTimeout = Math.max(
      params.timeoutMs + Math.max(SIDECAR_WORST_CASE_MS, SIDECAR_SHELL_REPLY_MS) + 10_000,
      60_000,
    );
    return this.#request('exec_cell', { ...params }, transportTimeout, 'reclaim') as unknown as Promise<ExecCellResult>;
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
    await this.#waitExit(this.#killGraceMs);
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
      if (isSidecarResponse(message)) {
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
      // A sidecar-reported failure that happens BECAUSE the child is gone
      // (`start_kernel` is the common one) used to arrive with no detail at all:
      // the model saw "sidecar: <message>" and had to guess whether the
      // interpreter was missing, unusable or crashed (review v4 ROB-10 ✗).
      // Attaching the exit facts only while the transport is DOWN keeps normal
      // domain errors (`unknown kernel`) free of unrelated noise.
      const detail: Record<string, string> = {};
      if (!this.alive) {
        if (error.detail !== undefined) {
          detail['detail'] = error.detail;
        }
        Object.assign(detail, this.#failureDetail());
      } else if (error.detail !== undefined) {
        detail['detail'] = error.detail;
      }
      pending.reject(
        new IpynbError(this.#mapSidecarCode(error.code), `sidecar: ${error.message}`, detail),
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

  #request(
    op: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    onTimeout: TimeoutAction = 'wait',
  ): Promise<Record<string, unknown>> {
    if (this.#exited) {
      return Promise.reject(new IpynbError('kernel_died', this.#exitReason ?? 'sidecar is not running', this.#failureDetail()));
    }
    const request: SidecarRequest = { id: randomUUID(), op, params };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(
          new IpynbError(
            'kernel_died',
            `sidecar request timed out after ${timeoutMs}ms (op=${op})`,
            this.#failureDetail(),
          ),
        );
        if (onTimeout === 'reclaim') {
          // The sidecar owns this op's deadline and missed it, so it is wedged
          // (it holds no per-request cancellation). Reclaim the process tree so
          // the next call spawns a healthy one (review V2). Ops whose deadline
          // is OURS (`kernel_status`, `ping`, `analyze`) deliberately do NOT
          // reclaim: for those a timeout can simply mean "the sidecar is busy
          // elsewhere", and killing it would take down every kernel on this
          // interpreter (review v3 ROB-11).
          this.#reclaimAfterTimeout();
        }
      }, timeoutMs);
      this.#pending.set(request.id, { resolve, reject, timer });
      try {
        if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) {
          throw new Error('sidecar stdin is closed');
        }
        // Asynchronous write failures surface on the stream's 'error' listener
        // installed in the constructor, which funnels them through
        // #failTransport — a promise rejection instead of an uncaught
        // 'error' event (review V1/A20).
        this.#child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (cause) {
        this.#pending.delete(request.id);
        clearTimeout(timer);
        reject(new IpynbError('kernel_died', `cannot write to sidecar stdin: ${String(cause)}`, this.#failureDetail()));
      }
    });
  }

  /**
   * Diagnostics for the model when the sidecar dies or goes silent: the exit
   * status plus the tail of its stderr is the only clue about WHY (review v3
   * ROB-10 — the interpreter can pass `import ipykernel` and still be unable to
   * start a kernel, and the model used to get a bare exit code).
   */
  #failureDetail(): Record<string, string> {
    // BOTH halves travel together. Returning the stderr tail INSTEAD of the
    // exit reason (the v3 shape) meant the symbolized Windows status code was
    // computed and then discarded exactly when it mattered most — the pyzmq
    // abort writes to stderr, so `sidecar_stderr` always won and the reviewer
    // measured "symbolization 0% effective" (review v4 ROB-10).
    const detail: Record<string, string> = {};
    if (this.#exitReason !== null) {
      detail['sidecar_exit'] = this.#exitReason;
    }
    if (this.#stderrTail.length > 0) {
      detail['sidecar_stderr'] = this.#stderrTail.join('\n');
    }
    return detail;
  }

  /** One-shot teardown shared by exit/error/stdio failures; fires onExit once. */
  #failTransport(reason: string): void {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    this.#exitReason = reason;
    this.#failAllPending('kernel_died', reason);
    if (!this.#exitNotified) {
      this.#exitNotified = true;
      this.#onExit?.(reason);
    }
  }

  #reclaimAfterTimeout(): void {
    if (this.#reclaiming || this.#exited) {
      return;
    }
    this.#reclaiming = true;
    void this.#killTree()
      .catch((cause: unknown) => {
        this.#log?.('warn', `process-tree reclaim after a request timeout failed: ${String(cause)}`);
      })
      .finally(() => {
        // #killTree waits for the child's exit event; a host that ignores the
        // kill must still not hold the transport open (review A28).
        this.#failTransport(this.#exitReason ?? 'sidecar did not answer and was reclaimed');
      });
  }

  #failAllPending(code: 'kernel_died', reason: string): void {
    const detail = this.#failureDetail();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new IpynbError(code, reason, detail));
    }
  }

  #mapSidecarCode(code: string): 'kernel_died' | 'kernel_busy' | 'internal' {
    if (code === 'kernel_died' || code === 'kernel_busy') {
      return code;
    }
    return 'internal';
  }
}

/**
 * Windows reports a crash as a huge unsigned NTSTATUS (e.g. 1073741845 for
 * 0xC0000409, the stack-buffer-overrun that a broken pyzmq produces). A raw
 * number is unactionable for the model reading the error, which is exactly the
 * scenario review v3 ROB-10 documents (review §0 promises self-diagnosable
 * failures).
 */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  const signalPart = `signal=${signal === null ? 'null' : signal}`;
  if (code === null) {
    return `code=null, ${signalPart}`;
  }
  const status = WINDOWS_STATUS_NAMES[code];
  const hex = code < 0 || code > 0xffff ? `0x${(code >>> 0).toString(16).toUpperCase()}` : null;
  const codePart = hex === null ? `code=${code}` : `code=${code} (${hex})`;
  return status === undefined ? `${codePart}, ${signalPart}` : `${codePart} = ${status}, ${signalPart}`;
}

const WINDOWS_STATUS_NAMES: Readonly<Record<number, string>> = {
  0xc0000005: 'STATUS_ACCESS_VIOLATION',
  0xc000001d: 'STATUS_ILLEGAL_INSTRUCTION',
  0xc0000094: 'STATUS_INTEGER_DIVIDE_BY_ZERO',
  0xc00000fd: 'STATUS_STACK_OVERFLOW',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN',
  0xc0000602: 'STATUS_FAIL_FAST_EXCEPTION',
  0xc000013a: 'STATUS_CONTROL_C_EXIT',
  0xc0000135: 'STATUS_DLL_NOT_FOUND',
  0xc0000142: 'STATUS_DLL_INIT_FAILED',
};
