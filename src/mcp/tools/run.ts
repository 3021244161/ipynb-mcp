// notebook_run tool (SPEC §4.7, D14): synchronous for short runs, background
// handle + polling when timeout_seconds * target cells exceeds the threshold.

import { IpynbError, type JsonValue } from '../../core/errors.js';
import { cellSource } from '../../core/parse.js';
import { readNotebookFile } from '../../fs/notebook-file.js';
import type { ToolContext } from '../context.js';
import {
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  requireNonEmptyString,
} from '../context.js';
import { parseCellSelector, runNotebook, type RunOutcome } from '../../run.js';
import { runTool, type ToolOutcome } from './result.js';

export const notebookRunDescription =
  "Execute notebook cells. mode='resume' runs only the target cells in the live kernel; 'replay' silently rebuilds state from cell 0 first; 'full' re-runs everything.";

export interface RunToolHooks {
  /** Progress notifications (client provided _meta.progressToken). */
  readonly onProgress?: (event: { progress: number; total: number; phase: string }) => void;
  readonly signal?: AbortSignal;
}

export async function handleNotebookRun(
  ctx: ToolContext,
  args: Record<string, unknown>,
  hooks?: RunToolHooks,
): Promise<ToolOutcome> {
  return runTool(async () => {
    const inputPath = requireNonEmptyString(args, 'path');
    const cellSelector = (() => {
      const value = args['cell_selector'];
      if (value === undefined) {
        return 'all';
      }
      if (typeof value !== 'string') {
        throw new IpynbError('invalid_arguments', "invalid argument 'cell_selector': must be a string selector", {
          field: 'cell_selector',
        });
      }
      return value;
    })();
    const mode = optionalEnum(args, 'mode', ['auto', 'resume', 'replay', 'full'] as const, 'auto');
    const timeoutSeconds = optionalInteger(args, 'timeout_seconds', 1, 86400, ctx.config.execTimeoutSeconds);
    const writeOutputs = optionalBoolean(args, 'write_outputs', true);
    const clearOutputsBefore = optionalBoolean(args, 'clear_outputs_before', true);
    const expectedContentHash = optionalString(args, 'expected_content_hash');
    const createBackup = optionalBoolean(args, 'create_backup', true);

    const absolutePath = ctx.fence.assertInside(inputPath);

    // Estimate the run size for the background decision (D14).
    const notebook = await readNotebookFile(absolutePath, ctx.hasher);
    if (expectedContentHash !== undefined && expectedContentHash !== notebook.contentHash) {
      throw new IpynbError('file_changed', 'notebook changed since it was read', {
        expected: expectedContentHash,
        actual: notebook.contentHash,
      });
    }
    const codeCellCount = notebook.cells.filter((cell) => cell.cell_type === 'code').length;
    let targetCount: number;
    if (cellSelector.trim() === 'all' || cellSelector.trim() === '' || mode === 'full') {
      targetCount = codeCellCount;
    } else {
      const codeIndexes = notebook.cells
        .map((cell, index) => (cell.cell_type === 'code' ? index : -1))
        .filter((index) => index >= 0);
      targetCount = parseCellSelector(cellSelector, codeIndexes).length;
    }
    // Client cancellation interrupts the in-flight cell immediately (SPEC §4.6.2).
    if (hooks?.signal !== undefined && !hooks.signal.aborted) {
      hooks.signal.addEventListener('abort', () => {
        void ctx.registry.interrupt(absolutePath).catch(() => {
          // kernel may already be gone
        });
      });
    }

    const goesBackground = timeoutSeconds * targetCount > ctx.config.backgroundThresholdSeconds;

    if (!goesBackground) {
      const outcome = await runNotebook(
        {
          path: absolutePath,
          cellSelector,
          mode,
          timeoutSeconds,
          writeOutputs,
          clearOutputsBefore,
          expectedContentHash,
          createBackup,
          ...(hooks?.signal !== undefined
            ? { abort: { signal: hooks.signal, reason: 'cancelled' as const } }
            : {}),
        },
        {
          registry: ctx.registry,
          hasher: ctx.hasher,
          config: ctx.config,
          imagesPolicy: ctx.config.images,
          logger: ctx.logger,
          realpath: ctx.realpath,
          platform: ctx.platform,
          onProgress: hooks?.onProgress
            ? (event) => {
                hooks.onProgress?.({
                  progress: event.phase === 'cell' ? event.completed : 0,
                  total: event.total,
                  phase: event.phase,
                });
              }
            : undefined,
        },
      );
      return { payload: completedPayload(outcome), imageBlocks: outcome.image_blocks };
    }

    // ---- background path ----
    const handle = ctx.runStore.create(absolutePath, targetCount);
    void executeBackgroundRun(ctx, handle, {
      path: absolutePath,
      cellSelector,
      mode,
      timeoutSeconds,
      writeOutputs,
      clearOutputsBefore,
      expectedContentHash,
      createBackup,
    }, hooks);

    const payload: Record<string, unknown> = {
      kind: 'background',
      run_id: handle.runId,
      status: 'running',
      kernel_id: null,
      poll_after_ms: 2000,
    };
    return { payload: payload as unknown as JsonValue };
  });
}

async function executeBackgroundRun(
  ctx: ToolContext,
  handle: import('../run-store.js').RunHandle,
  request: Parameters<typeof runNotebook>[0],
  hooks?: RunToolHooks,
): Promise<void> {
  try {
    const outcome = await runNotebook(
      { ...request, abort: { signal: handle.abortController.signal, reason: handle.abortReason ?? 'cancelled' } },
      {
        registry: ctx.registry,
        hasher: ctx.hasher,
        config: ctx.config,
        imagesPolicy: ctx.config.images,
        logger: ctx.logger,
        realpath: ctx.realpath,
        platform: ctx.platform,
        onProgress: (event) => {
          if (event.phase === 'cell') {
            handle.progress = {
              completed: event.completed,
              total: event.total,
              currentCellIndex: event.current_cell_index,
            };
          }
          hooks?.onProgress?.({
            progress: event.phase === 'cell' ? event.completed : 0,
            total: event.total,
            phase: event.phase,
          });
        },
      },
    );
    handle.kernelId = outcome.kernel_id;
    handle.executed = outcome.executed;
    handle.replayedCellIndexes = outcome.replayed_cell_indexes;
    handle.staleCells = outcome.stale_cells;
    handle.staleAnalysis = outcome.stale_analysis;
    handle.writeBack = { performed: outcome.write_back.performed, backupPath: outcome.write_back.backup_path };
    handle.warnings = outcome.warnings;
    handle.imageBlocks = outcome.image_blocks;
    handle.state = 'completed';
  } catch (cause) {
    const error = cause instanceof IpynbError ? cause : new IpynbError('internal', String(cause));
    // The run-store marker is authoritative: restart/shutdown mark
    // kernel_died even though the cooperative abort raised 'cancelled'
    // (the reason was fixed when the run started).
    if (handle.abortReason === 'kernel_died') {
      handle.state = 'failed';
      handle.error = { code: 'kernel_died', message: 'kernel was shut down or restarted while the run was in flight' };
    } else {
      handle.state = error.code === 'cancelled' ? 'cancelled' : 'failed';
      handle.error = { code: error.code, message: error.message };
    }
    // Best-effort detail extraction for write-back reporting in the failure.
    if (error.detail !== undefined && typeof error.detail === 'object' && error.detail !== null) {
      const detail = error.detail as Record<string, unknown>;
      const writeBack = detail['write_back'];
      if (typeof writeBack === 'object' && writeBack !== null) {
        const performed = (writeBack as Record<string, unknown>)['performed'];
        const backupPath = (writeBack as Record<string, unknown>)['backup_path'];
        handle.writeBack = {
          performed: performed === true,
          backupPath: typeof backupPath === 'string' ? backupPath : null,
        };
      }
    }
  } finally {
    handle.progress.currentCellIndex = null;
    ctx.runStore.finish(handle.runId);
  }
}

function completedPayload(outcome: RunOutcome): JsonValue {
  return {
    kind: 'completed',
    path: outcome.path,
    mode_requested: outcome.mode_requested,
    mode_used: outcome.mode_used,
    kernel_id: outcome.kernel_id,
    interpreter_path: outcome.interpreter_path,
    kernel_language: outcome.kernel_language,
    executed: outcome.executed,
    replayed_cell_indexes: outcome.replayed_cell_indexes,
    stale_cells: outcome.stale_cells,
    stale_analysis: outcome.stale_analysis,
    kernel_alive: outcome.kernel_alive,
    write_back: outcome.write_back,
    warnings: outcome.warnings,
    content_hash_after: outcome.content_hash_after,
  } as unknown as JsonValue;
}

export { cellSource };
