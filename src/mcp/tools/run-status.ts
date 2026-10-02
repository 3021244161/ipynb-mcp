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
      write_back: handle.writeBack,
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
      handle.abortReason = 'cancelled';
      handle.abortController.abort();
      handle.state = 'cancelled';
      handle.error = { code: 'cancelled', message: 'run cancelled by the client' };
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
    };
    return { payload: payload as JsonValue };
  });
}
