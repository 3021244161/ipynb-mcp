// notebook_run_status / notebook_run_cancel tools (SPEC §4.8).

import { IpynbError, type JsonValue } from '../../core/errors.js';
import { rejectUnknownArguments, requireNonEmptyString, type ToolContext } from '../context.js';
import { runTool, type ToolOutcome } from './result.js';

/** Declared arguments (SPEC §4.8); anything else is a caller mistake (SEC-1). */
export const RUN_STATUS_ARGUMENTS = ['run_id'] as const;

export const notebookRunStatusDescription = 'Poll a background notebook run started by notebook_run.';
export const notebookRunCancelDescription = 'Cancel a background notebook run started by notebook_run.';

export async function handleRunStatus(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return runTool(async () => {
    rejectUnknownArguments(args, RUN_STATUS_ARGUMENTS);
    const runId = requireNonEmptyString(args, 'run_id');
    const handle = ctx.runStore.get(runId);
    if (handle === null) {
      throw new IpynbError('run_not_found', `unknown run_id: ${runId}`, { run_id: runId });
    }
    const payload: Record<string, unknown> = {
      run_id: handle.runId,
      state: handle.state,
      kernel_id: handle.kernelId,
      progress: {
        completed: handle.progress.completed,
        total: handle.progress.total,
        current_cell_index: handle.progress.currentCellIndex,
      },
      executed: handle.executed,
      replayed_cell_indexes: handle.replayedCellIndexes,
      stale_cells: handle.staleCells,
      stale_analysis: handle.staleAnalysis,
      // SPEC §4.8 spells this field snake_case, and the completed-run payload
      // (notebook_run) already does: the handle's internal camelCase shape used
      // to leak through verbatim, so the SAME field was `backup_path` in one
      // tool and `backupPath` in the other — a tool consumer cannot guess which
      // (review v4 FID-5).
      write_back: {
        performed: handle.writeBack.performed,
        backup_path: handle.writeBack.backupPath,
      },
      // `true` while the background task is still unwinding: the terminal state above is
      // already final, but `executed` / `warnings` / `write_back` will still be replaced
      // with what the run actually did. Without this field a cancelled run reports an
      // empty, self-consistent "nothing happened" for as long as the in-flight cell runs —
      // and then the file changes underneath the client (review v11 V11-3).
      facts_pending: handle.factsPending,
      error: handle.error,
      warnings: handle.warnings,
    };
    return { payload: payload as JsonValue, imageBlocks: handle.imageBlocks };
  });
}

export async function handleRunCancel(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return runTool(async () => {
    rejectUnknownArguments(args, RUN_STATUS_ARGUMENTS);
    const runId = requireNonEmptyString(args, 'run_id');
    const handle = ctx.runStore.get(runId);
    if (handle === null) {
      throw new IpynbError('run_not_found', `unknown run_id: ${runId}`, { run_id: runId });
    }
    if (handle.state === 'running') {
      // SPEC §4.8 rule 1: cancelling lands the run in its terminal state
      // IMMEDIATELY, without waiting for the in-flight cell. The old body
      // aborted and then slept 50 ms hoping the background task would catch up,
      // so it could return `state: "running"` — a value the §4.8 response enum
      // does not contain (review v3 QUAL-8). The background task then writes
      // the completed cells back under this same terminal state.
      //
      // Publishing a terminal state before its facts exist is only honest if the payload
      // SAYS the facts are outstanding, so `facts_pending` is raised here and the rule that
      // owns it is `RunHandle.factsPending` (review v11 V11-3). The alternative — holding
      // the state open until the cell finishes — was rejected because §4.8 rule 1 is
      // explicit and the model would keep waiting on a cell it just asked to stop.
      handle.factsPending = true;
      handle.abortReason = 'cancelled';
      handle.abortController.abort();
      // The first writer wins: the background task may already have settled the
      // run, and a cancel must not overwrite a terminal state any more than the
      // reverse (review v5 NEW5-REPRO).
      ctx.runStore.settle(handle.runId, 'cancelled', { code: 'cancelled', message: 'run cancelled by the client' });
      try {
        await ctx.registry.interrupt(handle.notebookPath);
      } catch (cause) {
        // The abort is the authoritative cancellation signal; a failed
        // interrupt only means the user's long task may keep running, which
        // must be visible in the logs (R7, review A24).
        ctx.logger.warn(`interrupt during cancel of ${handle.runId} failed: ${String(cause)}`);
      }
    }
    const payload: Record<string, unknown> = {
      run_id: handle.runId,
      state: handle.state,
      kernel_shutdown: false,
      // SPEC §4.8's cancel response is three fields and this is a fourth; it is the same
      // fact the status payload carries, and a caller that acts on `state: "cancelled"`
      // alone needs it here most (D-055).
      facts_pending: handle.factsPending,
    };
    return { payload: payload as JsonValue };
  });
}
