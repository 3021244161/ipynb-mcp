// notebook_run_status / notebook_run_cancel tools (SPEC §4.8).

import { IpynbError, type JsonValue } from '../../core/errors.js';
import { requireNonEmptyString, type ToolContext } from '../context.js';
import { runTool, type ToolOutcome } from './result.js';

export const notebookRunStatusDescription = 'Poll a background notebook run started by notebook_run.';
export const notebookRunCancelDescription = 'Cancel a background notebook run started by notebook_run.';

export async function handleRunStatus(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return runTool(async () => {
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
    const runId = requireNonEmptyString(args, 'run_id');
    const handle = ctx.runStore.get(runId);
    if (handle === null) {
      throw new IpynbError('run_not_found', `unknown run_id: ${runId}`, { run_id: runId });
    }
    if (handle.state === 'running') {
      // Idempotent cancel: abort cooperatively and interrupt the kernel
      // best-effort; the run lands in state 'cancelled' on its own.
      handle.abortReason = 'cancelled';
      handle.abortController.abort();
      try {
        await ctx.registry.interrupt(handle.notebookPath);
      } catch (cause) {
        // The abort is the authoritative cancellation signal; a failed
        // interrupt only means the user's long task may keep running, which
        // must be visible in the logs (R7, review A24).
        ctx.logger.warn(`interrupt during cancel of ${handle.runId} failed: ${String(cause)}`);
      }
      // Give the background task a tick to observe the abort.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const payload: Record<string, unknown> = {
      run_id: handle.runId,
      state: handle.state,
      kernel_shutdown: false,
    };
    return { payload: payload as JsonValue };
  });
}
