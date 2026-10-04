// Background run handles (SPEC §4.8): run_id lifecycle, progress snapshot,
// retention of at most 20 finished runs or 10 minutes (whichever first).

import type { Warning } from '../core/errors.js';
import type { ExecutedCell, RunImageBlock, RunOutcome } from '../run.js';

export type RunState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunHandle {
  readonly runId: string;
  readonly notebookPath: string;
  state: RunState;
  kernelId: string | null;
  progress: { completed: number; total: number; currentCellIndex: number | null };
  executed: ExecutedCell[];
  replayedCellIndexes: number[];
  staleCells: RunOutcome['stale_cells'];
  staleAnalysis: RunOutcome['stale_analysis'];
  writeBack: { performed: boolean; backupPath: string | null };
  error: { code: string; message: string } | null;
  warnings: Warning[];
  imageBlocks: RunImageBlock[];
  /**
   * Are the facts (`executed`, `warnings`, `write_back`) still being gathered?
   *
   * `notebook_run_cancel` publishes the terminal state IMMEDIATELY (SPEC §4.8 rule 1) while
   * the in-flight cell keeps running, and everything that cell's run has to report arrives
   * only when the background task unwinds. So for a window — the remainder of the in-flight
   * cell, 25 s on Windows where the kernel interrupt does nothing — the status of a run that
   * has already executed cells and may rewrite the file is `cancelled` + `executed: []` +
   * `warnings: []` + `write_back: {performed: false}`. A client is entitled to read that as
   * "nothing ran, nothing was written, nothing was lost", and to run the notebook again.
   *
   * The terminal state is a promise about the run, and the facts are the promise's content:
   * they must either arrive with it or be declared outstanding. This field is that
   * declaration (review v11 V11-3; the rule is AGENTS §9's "terminal state and facts arrive
   * together").
   *
   * INVARIANT: `facts_pending` is false exactly when nothing more will be written to this
   * handle. The background task clears it in its last statement, after the terminal state
   * and the facts have both been written.
   */
  factsPending: boolean;
  readonly createdAt: number;
  finishedAt: number | null;
  readonly abortController: AbortController;
  abortReason: 'cancelled' | 'kernel_died' | null;
}

export const MAX_COMPLETED_RUNS = 20;
export const RUN_RETENTION_MS = 10 * 60 * 1000;

export class RunStore {
  readonly #runs = new Map<string, RunHandle>();
  #nextId = 1;
  #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  create(notebookPath: string, total: number): RunHandle {
    const handle: RunHandle = {
      runId: `run-${this.#nextId}`,
      notebookPath,
      state: 'running',
      kernelId: null,
      progress: { completed: 0, total, currentCellIndex: null },
      executed: [],
      replayedCellIndexes: [],
      staleCells: [],
      staleAnalysis: null,
      writeBack: { performed: false, backupPath: null },
      error: null,
      warnings: [],
      imageBlocks: [],
      factsPending: false,
      createdAt: this.#now(),
      finishedAt: null,
      abortController: new AbortController(),
      abortReason: null,
    };
    this.#nextId += 1;
    this.#runs.set(handle.runId, handle);
    return handle;
  }

  get(runId: string): RunHandle | null {
    this.prune();
    return this.#runs.get(runId) ?? null;
  }

  /** All run ids currently in state 'running'. */
  listRunningRunIds(): string[] {
    return [...this.#runs.values()].filter((run) => run.state === 'running').map((run) => run.runId);
  }

  /**
   * Move a run to its terminal state, ONCE.
   *
   * Returns false when the run already left `running`, and the caller must then
   * leave the recorded outcome alone. Two writers race here by construction:
   * `notebook_run_cancel` lands `cancelled` immediately (SPEC §4.8 rule 1) while
   * the background task keeps running, and a background task can also finish
   * between a cancel and the status query. Without this, `completed` could be
   * written over a `cancelled` that the client had already been told about —
   * the terminal state a client observed was not stable (review v5 NEW5-REPRO,
   * reproduced by the v6 review).
   */
  settle(
    runId: string,
    state: Exclude<RunState, 'running'>,
    error?: { code: string; message: string },
  ): boolean {
    const handle = this.#runs.get(runId);
    if (handle === undefined || handle.state !== 'running') {
      return false;
    }
    handle.state = state;
    if (error !== undefined) {
      handle.error = error;
    }
    return true;
  }

  /** Mark finished and apply retention (20 finished or 10 minutes). */
  finish(runId: string): void {
    const handle = this.#runs.get(runId);
    if (handle !== undefined && handle.state === 'running') {
      handle.state = 'failed';
      handle.error = { code: 'internal', message: 'run ended without a terminal state' };
    }
    if (handle !== undefined) {
      handle.finishedAt = this.#now();
    }
    this.prune();
  }

  prune(): void {
    const finished = [...this.#runs.values()].filter((run) => run.state !== 'running');
    const now = this.#now();
    // Time-based retention first.
    for (const run of finished) {
      if (run.finishedAt !== null && now - run.finishedAt > RUN_RETENTION_MS) {
        this.#runs.delete(run.runId);
      }
    }
    // Count-based retention: keep the newest MAX_COMPLETED_RUNS finished runs.
    const remaining = [...this.#runs.values()]
      .filter((run) => run.state !== 'running')
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
    for (let i = MAX_COMPLETED_RUNS; i < remaining.length; i += 1) {
      this.#runs.delete(remaining[i]!.runId);
    }
  }
}
