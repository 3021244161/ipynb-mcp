// Execution orchestration (SPEC §4.7): selector parsing, the mode matrix,
// sequential cell execution with replay's silent prefix, output mapping and
// the guarded write-back. This module composes core/fs/kernel pieces and is
// the only cross-layer assembly point; mcp/tools/run.ts calls runNotebook.

import {
  IpynbError,
  PREEXISTING_CONTENT_WARNING,
  createWarning,
  isAbortCause,
  type JsonValue,
  type Warning,
} from './core/errors.js';
import {
  assembleCallWarnings,
  collectOutputWarnings,
  dropUnrepresentableOutputs,
  mapRawOutputs,
  nbformatOutputsOfRaw,
  representableExecutionCount,
  type DroppedMime,
  type OutputItem,
} from './core/outputs.js';
import { cellSource, readNotebookMetadata, type Hasher, type NotebookDoc, type NotebookFile } from './core/parse.js';
import { analyzeStale, downgradeConfidence, regexDefs, regexUses, type StaleCell } from './core/stale.js';
import type { IpynbConfig } from './config.js';
import { applyImagePolicy, shouldReturnImages, type ImagesPolicy } from './fs/artifact.js';
import { readNotebookFile, writeNotebookFile } from './fs/notebook-file.js';
import type { KernelRegistry } from './kernel/registry.js';
import { resolveForNotebook } from './kernel/interpreter.js';
import type { Logger } from './log.js';

export type RunMode = 'auto' | 'resume' | 'replay' | 'full';
export type ModeUsed = 'resume' | 'replay' | 'full';

/**
 * Append the call's output warnings to `warnings`, once each.
 *
 * The RULE lives in core (`assembleCallWarnings`) so a unit test can drive it with real
 * inputs; this is only the "append without repeating yourself" half. Every exit of a run
 * goes through it — successful, timeout, cancelled and kernel_died (see `failedRunError`),
 * because a run that has already rewritten the file and dropped values must not report
 * having lost nothing, whatever ended it.
 */
function pushCallWarnings(
  warnings: Warning[],
  executed: readonly ExecutedCell[],
  droppedMimes: readonly DroppedMime[],
): void {
  for (const assembled of assembleCallWarnings(executed, droppedMimes)) {
    if (!warnings.some((warning) => warning.message === assembled.message)) {
      warnings.push(createWarning(assembled.code, assembled.message));
    }
  }
}

export interface RunRequest {
  readonly path: string;
  readonly cellSelector: string;
  readonly mode: RunMode;
  readonly timeoutSeconds: number;
  readonly writeOutputs: boolean;
  readonly clearOutputsBefore: boolean;
  readonly expectedContentHash?: string;
  readonly createBackup: boolean;
  /** Cooperative cancellation: checked between cells; completed cells are still written back. */
  readonly abort?: {
    readonly signal: AbortSignal;
    readonly reason: 'cancelled' | 'kernel_died';
  };
}

export interface ExecutedCell {
  readonly cell_index: number;
  readonly cell_id: string | null;
  readonly status: 'ok' | 'error' | 'timeout';
  readonly duration_ms: number;
  readonly execution_count: number | null;
  readonly outputs: OutputItem[];
}

export interface RunImageBlock {
  readonly data: string;
  readonly media_type: 'image/png' | 'image/jpeg';
}

export interface RunOutcome {
  readonly kind: 'completed';
  readonly path: string;
  readonly mode_requested: RunMode;
  readonly mode_used: ModeUsed;
  readonly kernel_id: string;
  readonly interpreter_path: string;
  readonly kernel_language: string;
  readonly executed: ExecutedCell[];
  readonly replayed_cell_indexes: number[];
  readonly stale_cells: ReadonlyArray<{
    cell_index: number;
    cell_id: string | null;
    reason: string;
    confidence: 'high' | 'low';
  }>;
  readonly stale_analysis: { approximate: true; analysis_version: 1; method: 'python-symtable' | 'regex' | 'skipped' } | null;
  readonly kernel_alive: boolean;
  /**
   * `performed: false` alone cannot tell "nothing to write" from "the write
   * itself failed"; a failure on the error path carries `reason` so the
   * primary error code is never replaced by it (review W3).
   */
  readonly write_back: {
    performed: boolean;
    backup_path: string | null;
    reason?: string;
  };
  readonly warnings: Warning[];
  readonly image_blocks: RunImageBlock[];
  readonly content_hash_after: string | null;
}

export type RunProgressEvent =
  | { readonly phase: 'start'; readonly total: number }
  | { readonly phase: 'cell'; readonly completed: number; readonly total: number; readonly current_cell_index: number }
  | { readonly phase: 'write_back'; readonly completed: number; readonly total: number };

export interface RunDeps {
  readonly registry: KernelRegistry;
  readonly hasher: Hasher;
  readonly config: IpynbConfig;
  readonly imagesPolicy: ImagesPolicy;
  readonly logger?: Logger;
  readonly realpath: (target: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly onProgress?: (event: RunProgressEvent) => void;
}

/** Parse a cell_selector into ascending deduped code-cell indexes (SPEC §4.7). */
export function parseCellSelector(
  selector: string,
  codeCellIndexes: readonly number[],
): number[] {
  const trimmed = selector.trim();
  if (trimmed === 'all' || trimmed === '') {
    return [...codeCellIndexes];
  }
  if (!/^[0-9,-]+$/.test(trimmed)) {
    throw new IpynbError('invalid_targets', `invalid cell_selector: ${selector}`, {
      cell_selector: selector,
    });
  }
  const selected = new Set<number>();
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (piece === '') {
      throw new IpynbError('invalid_targets', `invalid cell_selector: ${selector}`, {
        cell_selector: selector,
      });
    }
    if (piece.includes('-')) {
      const parts = piece.split('-');
      if (parts.length !== 2) {
        // '1-2-3' silently truncated to 1-2 before (review A10): executing a
        // WRONG cell set is worse than rejecting the selector.
        throw new IpynbError('invalid_targets', `invalid range in cell_selector: ${piece}`, {
          cell_selector: selector,
        });
      }
      const rawStart = parts[0] ?? '';
      const rawEnd = parts[1] ?? '';
      // A leading '-' is the same class of silent misread as '1-2-3': '-1'
      // split into '' and '1', and Number('') === 0 turned it into the range
      // 0-1 — running cells the caller never asked for (review W10).
      if (rawStart === '' || rawEnd === '') {
        throw new IpynbError('invalid_targets', `invalid range in cell_selector: ${piece}`, {
          cell_selector: selector,
        });
      }
      const start = Number(rawStart);
      const end = Number(rawEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new IpynbError('invalid_targets', `invalid range in cell_selector: ${piece}`, {
          cell_selector: selector,
        });
      }
      if (start > end) {
        throw new IpynbError('invalid_targets', `descending range in cell_selector: ${piece}`, {
          cell_selector: selector,
        });
      }
      for (let i = start; i <= end; i += 1) {
        selected.add(i);
      }
    } else {
      const value = Number(piece);
      if (!Number.isInteger(value)) {
        throw new IpynbError('invalid_targets', `invalid index in cell_selector: ${piece}`, {
          cell_selector: selector,
        });
      }
      selected.add(value);
    }
  }
  const sorted = [...selected].sort((a, b) => a - b);
  return sorted;
}

export async function runNotebook(req: RunRequest, deps: RunDeps): Promise<RunOutcome> {
  const warnings: Warning[] = [];
  const platform = deps.platform ?? process.platform;
  const notebook = await readNotebookFile(req.path, deps.hasher);

  if (req.expectedContentHash !== undefined && req.expectedContentHash !== notebook.contentHash) {
    throw new IpynbError('file_changed', 'notebook changed since it was read', {
      expected: req.expectedContentHash,
      actual: notebook.contentHash,
    });
  }

  // External modification while a kernel was live? (SPEC §5.3)
  const liveSession = deps.registry.findByNotebook(req.path);
  if (liveSession !== null) {
    const seen = deps.registry.lastSeenContentHash(req.path);
    if (seen !== null && seen !== notebook.contentHash) {
      warnings.push(createWarning(
        'file_changed_externally',
        'notebook file changed outside this tool while a kernel was live',
      ));
    }
  }

  // Interpreter + kernelspec resolution (D23) via the shared single entry:
  // runNotebook and notebook_kernel share the ipykernel probe cache (B1).
  const notebookMeta = readNotebookMetadata(notebook.doc);
  const resolution = await resolveForNotebook(
    { notebookPath: req.path, explicitPython: deps.config.python, platform },
    { kernelSpecName: notebookMeta.kernelName, languageInfoName: notebookMeta.languageName },
  );
  for (const warning of resolution.warnings) {
    if (!warnings.some((existing) => existing.code === warning.code)) {
      warnings.push(warning);
    }
  }

  // Selector over code cells only; non-code targets are invalid (SPEC §4.7).
  const codeCellIndexes: number[] = [];
  for (const [index, cell] of notebook.cells.entries()) {
    if (cell.cell_type === 'code') {
      codeCellIndexes.push(index);
    }
  }
  const selected = parseCellSelector(req.cellSelector, codeCellIndexes);
  for (const index of selected) {
    const cell = notebook.cells[index];
    if (cell === undefined) {
      // Index beyond the notebook is a bounds problem, not a target-shape
      // problem (SPEC §4.7 / §7 split, review A11).
      throw new IpynbError('range_out_of_bounds', `cell_selector index ${index} is beyond the last cell (${notebook.cells.length - 1})`, {
        cell_selector: req.cellSelector,
        cell_index: index,
      });
    }
    if (cell.cell_type !== 'code') {
      throw new IpynbError('invalid_targets', `cell_selector points at a ${cell.cell_type} cell: ${index}`, {
        cell_selector: req.cellSelector,
        cell_index: index,
      });
    }
  }
  if (selected.length === 0 && codeCellIndexes.length > 0 && req.cellSelector.trim() !== 'all' && req.cellSelector.trim() !== '') {
    throw new IpynbError('range_out_of_bounds', `cell_selector selects no cells: ${req.cellSelector}`, {
      cell_selector: req.cellSelector,
    });
  }

  // ---- mode matrix (SPEC §4.7) ----------------------------------------------
  // "Live kernel" is a real probe, not the session record: a killed kernel
  // lingers in the registry until the sidecar's next request, and choosing
  // `resume` for it would run the prefix-less path against a dead kernel.
  const liveKernel = await deps.registry.liveKernel(req.path);
  const hasLiveKernel = liveKernel !== null;
  let modeUsed: ModeUsed;
  let targets = selected;
  let replayPrefix: number[] = [];

  const isAllSelector = req.cellSelector.trim() === 'all' || req.cellSelector.trim() === '';
  switch (req.mode) {
    case 'resume': {
      if (!hasLiveKernel) {
        throw new IpynbError('kernel_not_available', `mode 'resume' requires a live kernel for ${req.path}`, {
          path: req.path,
        });
      }
      modeUsed = 'resume';
      break;
    }
    case 'replay': {
      const first = selected[0] ?? 0;
      replayPrefix = codeCellIndexes.filter((index) => index < first);
      modeUsed = 'replay';
      break;
    }
    case 'full': {
      if (!isAllSelector) {
        warnings.push(createWarning(
          'targets_ignored',
          "mode 'full' executes every code cell; cell_selector is ignored",
        ));
      }
      targets = [...codeCellIndexes];
      modeUsed = 'full';
      break;
    }
    case 'auto': {
      if (isAllSelector) {
        modeUsed = hasLiveKernel ? 'resume' : 'full';
        targets = [...codeCellIndexes];
      } else {
        if (hasLiveKernel) {
          modeUsed = 'resume';
        } else {
          const first = selected[0] ?? 0;
          replayPrefix = codeCellIndexes.filter((index) => index < first);
          modeUsed = 'replay';
        }
      }
      break;
    }
    default: {
      const exhaustive: never = req.mode;
      throw new IpynbError('internal', `unhandled mode: ${String(exhaustive)}`);
    }
  }

  // Kernel death is an abort condition, not just an exception: when the kernel
  // is killed (OOM, external taskkill, restart) the cells that already finished
  // must still be written back and reported (SPEC §4.8 rule 3 / review R3).
  //
  // A termination only counts once a cell is actually in flight. Outside that
  // window the run notices the missing kernel by itself — via the session check
  // below and the `kernel_not_available` branch in the loop — which is what
  // makes a `notebook_kernel restart` landing between two cells a terminal
  // `kernel_died` instead of a silent continuation on the new kernel
  // (review v3 ROB-8).
  const kernelAbort = new AbortController();
  const kernelAbortState = { cellInFlight: false };
  const unregisterKernelAbort = deps.registry.onRunAbort(req.path, () => {
    if (kernelAbortState.cellInFlight) {
      kernelAbort.abort();
    }
  });
  // ROB-1: the merged signal registers listeners on a long-lived signal; they
  // must be detached on the normal path too, not only when abort fires.
  const merged = combineAbortSignals(req.abort?.signal, kernelAbort.signal);
  const abort: RunRequest['abort'] = {
    signal: merged.signal,
    // Without a client signal the only way this run can be aborted is the
    // kernel terminating, so that is the honest reason (SPEC §4.8 rule 1).
    reason: req.abort?.reason ?? 'kernel_died',
  };
  const effectiveReq: RunRequest = { ...req, abort };

  // ---- execution loop ------------------------------------------------------
  // clear_outputs_before applies per cell, immediately before that cell runs:
  // pre-clearing the whole target set would wipe outputs of cells that never
  // execute when a timeout/cancel interrupts the run (SPEC §4.7 rule 3).
  const executed: ExecutedCell[] = [];
  const imageBlocks: RunImageBlock[] = [];
  const executedCellsSet = new Set<number>();
  // Mime values dropped because nbformat cannot store them, collected across the
  // whole call so ONE warning can report this, any truncation, and any value the
  // JSON channel cannot carry exactly — see `pushCallWarnings` below. Each entry keeps
  // the cell it came from.
  const droppedMimes: DroppedMime[] = [];
  // Guards the failure-path write-back against running twice for one run.
  const abortState: AbortState = { writtenBack: false };
  // Running cursor so image_index stays unique across the whole call
  // (SPEC §4.3), not reset per cell (review A5).
  let imageCursor = 0;
  let sawTimeout = false;

  try {
    // Ensure the kernel exists (getOrCreate is idempotent per reuse key).
    const session = await deps.registry.getOrCreate({
      notebookPath: req.path,
      interpreterPath: resolution.interpreterPath,
      kernelSpecName: resolution.kernelSpecName,
      language: resolution.language,
      // replay must rebuild state on a NEW kernel (SPEC §4.7 matrix, review A4):
      // reusing a live one would leave stale variables masking prefix failures.
      fresh: modeUsed === 'replay',
      // The mode decision just probed this exact session; hand the answer over
      // so getOrCreate neither probes again nor flips the mode it was chosen
      // for if the kernel dies in between (review v3 ROB-14).
      ...(modeUsed === 'resume' ? { knownAlive: true } : {}),
    });

    // Run-level lock (review A6 / SPEC §10.2 I10): a second concurrent run on
    // the same kernel raises kernel_busy instead of interleaving cells.
    const releaseRun = deps.registry.acquireRun(req.path);
    try {
      // A `resume` promised to continue in the kernel whose state the caller
      // already has. If that exact session was replaced between the mode probe
      // and here (an explicit restart/shutdown landing in the gap, or a sidecar
      // exiting), running the targets anyway would execute them on a kernel
      // that never ran the earlier cells and write back a result that looks
      // successful while half of it is missing (review v3 ROB-8 item 8).
      // `replay` and `full` build their own state, so a fresh kernel is exactly
      // Snapshot the document BEFORE anything can mutate it: the write-back's
      // self check uses it to say whether a refusal is about our output or about
      // content that was already in the file (review v6 SCOPE-REFUSE-HINT). It
      // has to be taken this early because the failure paths below (a kernel that
      // died while the run was starting) already write back.
      const preRunDoc = structuredClone(notebook.doc);

      // what they asked for.
      const activeSession = deps.registry.findByNotebook(req.path);
      if (modeUsed === 'resume' && activeSession?.kernelId !== session.kernelId) {
        throw await failedRunError(
          'kernel_died',
          'kernel was shut down or restarted while the run was starting',
          executed,
          deps,
          abortState,
          notebook,
          effectiveReq,
          platform,
          executedCellsSet,
          preRunDoc,
          { warnings, droppedMimes },
        );
      }
      deps.onProgress?.({ phase: 'start', total: targets.length });

      // ---- replay prefix: silent, no outputs, no counters, nothing written ------
      for (const index of replayPrefix) {
        if (isAborted(effectiveReq.abort)) {
          break; // outer abort branch performs the (empty) write-back and raises
        }
        const cell = notebook.cells[index]!;
        await deps.registry.execCell(req.path, {
          code: cellSource(cell),
          silent: true,
          storeOutputs: false,
          timeoutMs: req.timeoutSeconds * 1000,
        });
      }

      for (const index of targets) {
        if (isAborted(effectiveReq.abort)) {
          break; // fall through to the outer abort branch: write back completed cells
        }
        const cell = notebook.cells[index]!;
        deps.onProgress?.({ phase: 'cell', completed: executed.length, total: targets.length, current_cell_index: index });
        const savedOutputs = cell.outputs;
        const savedCount = cell.execution_count;
        if (req.clearOutputsBefore) {
          cell.outputs = [];
          cell.execution_count = null;
        }
        let result;
          // A kernel termination only ends the run while one of OUR cells is in
          // flight (SPEC §4.8 rule 1). Outside that window the event is stale —
          // the sidecar notices a killed kernel on its next request, so an old
          // session's death can surface while this run is between cells.
        kernelAbortState.cellInFlight = true;
        try {
          result = await deps.registry.execCell(req.path, {
              code: cellSource(cell),
              silent: false,
              storeOutputs: true,
              timeoutMs: req.timeoutSeconds * 1000,
            });
        } catch (cause) {
          kernelAbortState.cellInFlight = false;
            // The in-flight cell is not a completed cell: its partial output never
            // lands (SPEC §4.8 rule 2).
          cell.outputs = savedOutputs;
          cell.execution_count = representableExecutionCount(savedCount);
          if (isAborted(effectiveReq.abort)) {
              // The kernel was killed while this cell was in flight (restart /
              // shutdown / client cancel raced the execution): fall through to
              // the abort branch so completed cells still get written back.
            break;
          }
          if (cause instanceof IpynbError && isKernelGone(cause)) {
              // The kernel died on its own (OOM, external kill, dead sidecar) or
              // was already gone before this cell could run (a restart/shutdown
              // landing between two cells). With no client signal nothing sets
              // isAborted(), and simply throwing here lost every cell that had
              // already completed — the run's own record of what it did
              // (SPEC §4.8 rule 3 / review R3, v3 ROB-8 item 7).
            throw await failedRunError(
              'kernel_died',
              cause.message,
              executed,
              deps,
              abortState,
              notebook,
              effectiveReq,
              platform,
              executedCellsSet,
              preRunDoc,
              { warnings, droppedMimes },
            );
          }
          throw cause;
        }
        kernelAbortState.cellInFlight = false;
        const mapped = mapRawOutputs(result.result.rawOutputs, {
            inlineTextChars: deps.config.inlineTextChars,
            maxImageBytes: deps.config.maxImageBytes,
            hasher: deps.hasher,
            // The cell index, so a failure message names it: without this every cell's broken
          // image produced the same string, and the run path's dedup collapsed them into one
          // (review v11 V11-10).
          cellIndex: index,
          });
          // Materialize images for run results (auto policy: always for runs).
        const returnImages = shouldReturnImages(deps.imagesPolicy, true);
        const policyResult = await applyImagePolicy(
            mapped.items,
            mapped.extractedImages,
            { returnImages, maxImages: deps.config.maxImagesPerCall, indexStart: imageCursor },
            {
              artifactRoot: deps.config.artifactDir,
              notebookAbsPath: req.path,
              cellIndex: index,
              platform,
              realpath: deps.realpath,
            },
          );
        for (const warning of policyResult.warnings) {
          if (!warnings.some((existing) => existing.code === warning.code)) {
            warnings.push(warning);
          }
        }
        imageCursor += policyResult.materialized.length;
        for (const materialized of policyResult.materialized) {
          const image = mapped.items[materialized.outputIndex];
          if (image === undefined || image.kind !== 'image') {
            continue;
          }
          // The payload travels with the materialization decision — it is the base64
          // of the bytes just written, so the SDK's validator cannot reject it. The
          // previous version re-read the document value by index, which handed a
          // `data:` URL straight to the SDK and failed the ENTIRE call with -32602
          // (review v9 V9-1).
          imageBlocks.push({ data: materialized.base64, media_type: image.media_type });
        }

        executed.push({
            cell_index: index,
            cell_id: cell.id ?? null,
            status: result.result.status,
            duration_ms: result.result.durationMs,
            execution_count: result.result.executionCount,
            outputs: mapped.items,
          });
        // Per-output problems are reported as soon as the output exists, not at the
        // end of the run: the timeout and abort exits below throw with the warnings
        // gathered SO FAR, and a value that cannot be represented exactly is exactly
        // the kind of thing those paths used to lose (review v9 V9-5, v7 V7-8).
        for (const lifted of collectOutputWarnings([{ outputs: mapped.items }])) {
          if (!warnings.some((existing) => existing.message === lifted.message)) {
            warnings.push(createWarning(lifted.code, lifted.message));
          }
        }

        if (result.result.status === 'timeout') {
            // Half-finished outputs of the interrupted cell never reach the file:
            // restore the pre-run outputs instead (SPEC §4.7 rule 5 / §4.8 rule 2).
          cell.outputs = savedOutputs;
          cell.execution_count = representableExecutionCount(savedCount);
          sawTimeout = true;
          break;
        }

          // A cell interrupted by the abort (status error) is NOT a completed
          // cell: its partial output never lands (SPEC §4.8 rule 2). Cells that
          // finished cleanly (ok) still count, even if the abort raced in.
        const abortedNow = isAborted(effectiveReq.abort);
        const interruptedByAbort = abortedNow && result.result.status === 'error';
        if (!interruptedByAbort) {
          // D15's boundary, write direction: the sidecar's private output shape
          // must never reach the file (SPEC §4.1.1). Assigning `rawOutputs`
          // directly produced invalid nbformat on every executed cell and the
          // tool's own read path could not read it back (review v4 FID-1).
          const converted = nbformatOutputsOfRaw(result.result.rawOutputs, result.result.executionCount);
          // …and before it is stored, drop what nbformat cannot represent. The
          // write gate would refuse the whole file otherwise, which loses every
          // cell of the run over one output value — a plain user cell can produce
          // one (review v6 GATE-5/CRASH-1).
          const sanitized = dropUnrepresentableOutputs(converted);
          // Collected, not warned here: the warning is emitted once per call by
          // `callWarnings`, which carries truncation, dropped values and values the
          // JSON channel cannot represent exactly. Pushing per cell let the first
          // fact silence the others (review v8 V8-10), and doing it inline made the
          // rule untestable (review v8 V8-4).
          droppedMimes.push(...sanitized.droppedMimes.map((mime) => ({ cellIndex: index, mime })));
          cell.outputs = sanitized.outputs;
          cell.execution_count = representableExecutionCount(result.result.executionCount);
          executedCellsSet.add(index);
        } else {
          cell.outputs = savedOutputs;
          cell.execution_count = representableExecutionCount(savedCount);
        }
        if (abortedNow) {
          break;
        }
      }

      if (sawTimeout) {
          // Write back the cells that DID complete (SPEC §4.7 rule 5), then raise
          // exec_timeout with the partial state in detail.
        abortState.writtenBack = true;
        // Before the write-back, which reports warnings of its own, and before the
        // throw, which freezes this array: a run that ends here must still say what
        // its COMPLETED cells lost (truncation, a dropped value, an inexact json
        // number). v8 assembled those after the loop, so this exit shipped an empty
        // list (review v9 V9-7).
        pushCallWarnings(warnings, executed, droppedMimes);
        const timeoutWriteBack = await writeBackCompleted(notebook, effectiveReq, deps, platform, executedCellsSet, warnings);
        const timeoutCell = executed[executed.length - 1];
        throw new IpynbError('exec_timeout', `cell execution timed out after ${req.timeoutSeconds}s (interrupt did not land)`, {
            cell_index: timeoutCell?.cell_index ?? null,
            completed_cells: executed.length - 1,
            // ExecutedCell is structurally JSON-safe; the cast bridges it to the
            // JsonValue union so failed-run status can report what actually ran.
            executed: executed as unknown as JsonValue,
            write_back: timeoutWriteBack,
            // The warnings gathered so far travel with the failure, exactly as
            // `failedRunError` does for cancelled/kernel_died. Without them a
            // timeout response was the ONE terminal shape that hid what the earlier
            // cells had already reported — a dropped output value, a pre-existing
            // quirk, a degraded stale analysis — because the run ends here and the
            // successful-path warnings are never reached (review v7 V7-8).
            warnings: warnings.map((warning) => ({ code: warning.code, message: warning.message })),
          });
      }

      if (isAborted(effectiveReq.abort)) {
          // Completed cells stay written; the interrupted cell never lands
          // (SPEC §4.8). This is the ONE terminal path for both the mid-cell abort
          // and the cancel that lands while the write-back is running (v3 ROB-8).
        pushCallWarnings(warnings, executed, droppedMimes);
        throw await abortedRunError(
          executed,
          deps,
          abortState,
          notebook,
          effectiveReq,
          platform,
          executedCellsSet,
          preRunDoc,
          { warnings, droppedMimes },
        );
      }

      // SPEC §7 defines `output_truncated` as "ANY OutputItem has
      // `truncated === true`", and says the whole call appends it ONCE. Two other
      // facts share the code (a dropped mime value, a json number this tool cannot
      // hold exactly), so they are assembled in ONE place — used by the successful
      // exit and by the timeout exit below. The v8 shape generated this after the
      // loop, so a timed-out run shipped `warnings: []` even when an earlier cell
      // had already lost a value (review v9 V9-7).
      pushCallWarnings(warnings, executed, droppedMimes);
      // ---- stale analysis (SPEC §5.6) --------------------------------------------
      let staleCells: RunOutcome['stale_cells'] = [];
      let staleAnalysis: RunOutcome['stale_analysis'] = null;
      if (resolution.language !== 'python') {
        staleAnalysis = { approximate: true, analysis_version: 1, method: 'skipped' };
        warnings.push(createWarning(
          'stale_analysis_skipped',
          'stale analysis is only available for Python kernels',
        ));
      } else {
        const codeSources = codeCellIndexes.map((index) => cellSource(notebook.cells[index]!));
        let defsByCodeIndex: string[][] = [];
        let usesByCodeIndex: string[][] = [];
        let method: 'python-symtable' | 'regex' = 'python-symtable';
        let degraded = false;
        try {
          const analysis = await deps.registry.analyze(req.path, codeSources);
          if (analysis.ok) {
            defsByCodeIndex = analysis.defs;
            usesByCodeIndex = analysis.uses;
          } else {
            degraded = true;
          }
        } catch {
          // Kernel unavailable (e.g. it just timed out): degrade to regex too.
          degraded = true;
        }
        if (degraded) {
          method = 'regex';
          warnings.push(createWarning(
            'stale_analysis_degraded',
            'at least one cell failed AST parsing; stale analysis degraded to regex (all confidences are low)',
          ));
          defsByCodeIndex = codeSources.map((source) => regexDefs(source));
          usesByCodeIndex = codeSources.map((source) => regexUses(source));
        }
        // Map code-index-aligned arrays onto full cell-index space. Built with
        // one forward pass: the previous `codeCellIndexes.indexOf(i)` inside the
        // loop was O(cells x code cells) (review v3 PERF-3).
        const codePositionOf = new Map<number, number>();
        for (const [position, cellIndex] of codeCellIndexes.entries()) {
          codePositionOf.set(cellIndex, position);
        }
        const defs: string[][] = [];
        const uses: string[][] = [];
        for (let i = 0; i < notebook.cells.length; i += 1) {
          const codePosition = codePositionOf.get(i);
          if (codePosition !== undefined) {
            defs[i] = defsByCodeIndex[codePosition] ?? [];
            uses[i] = usesByCodeIndex[codePosition] ?? [];
          } else {
            defs[i] = [];
            uses[i] = [];
          }
        }
        const staleMeta = notebook.cells.map((cell, index) => ({
          cell_index: index,
          cell_id: cell.id ?? null,
          is_code: cell.cell_type === 'code',
          has_nonempty_outputs: Array.isArray(cell.outputs) && cell.outputs.length > 0,
        }));
        let computed: StaleCell[] = analyzeStale({
          defs,
          uses,
          targetIndexes: executedCellsSet,
          replayIndexes: new Set(replayPrefix),
          cells: staleMeta,
        });
        if (method === 'regex') {
          computed = downgradeConfidence(computed);
        }
        staleCells = computed;
        staleAnalysis = { approximate: true, analysis_version: 1, method };
      }

      // ---- write-back -------------------------------------------------------------
      // Last chance to notice a cancel before the file is touched: the stale
      // analysis above can be a long RPC, and a cancel that lands during it must
      // not produce a normal `completed` result whose outputs were written after
      // the client was told the run was over (review v5 NEW5-REPRO: the window
      // exists on paper, and the terminal state is now single-writer so getting
      // it wrong is visible).
      if (isAborted(effectiveReq.abort)) {
        pushCallWarnings(warnings, executed, droppedMimes);
        throw await abortedRunError(
          executed,
          deps,
          abortState,
          notebook,
          effectiveReq,
          platform,
          executedCellsSet,
          preRunDoc,
          { warnings, droppedMimes },
        );
      }
      deps.onProgress?.({ phase: 'write_back', completed: executed.length, total: targets.length });
      let writeBack: RunOutcome['write_back'] = { performed: false, backup_path: null };
      let contentHashAfter: string | null = null;
      if (effectiveReq.writeOutputs && executedCellsSet.size > 0) {
        let writeResult;
        try {
          writeResult = await writeNotebookFile(notebook, req.path, {
            hasher: deps.hasher,
            backupKeep: deps.config.backupKeep,
            createBackup: req.createBackup,
            expectedContentHash: notebook.contentHash,
            // SPEC §4.1.10 / §4.6.2 (review V3): the main write-back honours the
            // cancellation signal — aborting discards the temp file and leaves
            // the notebook untouched. The failure-path write-back does not, by
            // design: there the write IS the abort handling.
            signal: req.abort?.signal,
            platform,
            // Diagnostics belong on the injected logger, not on atomic.ts's raw
            // stderr fallback: --log-level must be able to silence them (review W9).
            onCleanupError: (message) => deps.logger?.warn(message),
            // Only the cells this run executed are ours to answer for; content
            // that was already in the file must not block the write-back
            // (review v5 GATE-1).
            touchedCellIndexes: executedCellsSet,
            originalDoc: preRunDoc,
            // …and it must still be REPORTED to the caller, not only logged: the
            // model is the consumer, and a log line leaves it believing the file
            // is clean while the edit path already returns this warning (review
            // v6 WARN-CODE-1: the two paths disagreed).
            onStructuralWarning: (message) => {
              warnings.push(createWarning(PREEXISTING_CONTENT_WARNING, message));
              deps.logger?.warn(message);
            },
          });
        } catch (cause) {
          if (isAbortCause(cause, effectiveReq.abort?.signal)) {
            // A cancel that lands here (after the last cell, while the results are
            // being written) is the same terminal state as a cancel mid-cell: the
            // completed cells must still land and be reported. Throwing a bare
            // `cancelled` with no detail lost them silently and made one terminal
            // code answer with two different shapes (review v3 ROB-8).
            pushCallWarnings(warnings, executed, droppedMimes);
            throw await abortedRunError(
              executed,
              deps,
              abortState,
              notebook,
              effectiveReq,
              platform,
              executedCellsSet,
              preRunDoc,
              { warnings, droppedMimes },
            );
          }
          throw cause;
        }
        writeBack = { performed: true, backup_path: writeResult.backupPath };
        contentHashAfter = writeResult.contentHashAfter;
      }

      deps.registry.setLastSeenContentHash(req.path, contentHashAfter ?? notebook.contentHash);

      const aliveSession = deps.registry.findByNotebook(req.path);
      return {
        kind: 'completed',
        path: req.path,
        mode_requested: req.mode,
        mode_used: modeUsed,
        kernel_id: session.kernelId,
        interpreter_path: resolution.interpreterPath,
        kernel_language: resolution.language,
        executed,
        replayed_cell_indexes: replayPrefix,
        stale_cells: staleCells,
        stale_analysis: staleAnalysis,
        kernel_alive: aliveSession !== null && !sawTimeout,
        write_back: writeBack,
        warnings,
        image_blocks: imageBlocks,
        content_hash_after: contentHashAfter,
      };
    } finally {
      releaseRun();
    }
  } finally {
    merged.cleanup();
    unregisterKernelAbort();
  }
}

// ---------------------------------------------------------------------------

function isAborted(abort: RunRequest['abort']): boolean {
  return abort?.signal.aborted === true;
}

/** Kernel failures that mean "there is no live kernel for this cell to run on". */
function isKernelGone(cause: IpynbError): boolean {
  return cause.code === 'kernel_died' || cause.code === 'kernel_not_available';
}

/**
 * The ONE terminal path for a run cut short by cancellation or kernel death
 * (SPEC §4.8 rules 1/3). Collapsing both triggers here is what guarantees the
 * same answer whichever side of the write-back window the cancel lands on
 * (review v3 ROB-8).
 */
async function abortedRunError(
  executed: readonly ExecutedCell[],
  deps: RunDeps,
  abortState: AbortState,
  notebook: NotebookFile,
  req: RunRequest,
  platform: NodeJS.Platform,
  executedCellsSet: ReadonlySet<number>,
  preRunDoc: NotebookDoc,
  collected: { warnings: readonly Warning[]; droppedMimes: readonly DroppedMime[] },
): Promise<IpynbError> {
  const code = req.abort!.reason === 'kernel_died' ? 'kernel_died' : 'cancelled';
  return failedRunError(
    code,
    `run aborted (${code})`,
    executed,
    deps,
    abortState,
    notebook,
    req,
    platform,
    executedCellsSet,
    preRunDoc,
    collected,
  );
}

/**
 * Merge the client's cancellation signal with the registry's kernel-death
 * signal. A run has exactly one abort state, so both triggers must feed it
 * (review R3): completed cells are written back either way, and the terminal
 * error code comes from the reason the run was created with.
 *
 * Returns the detach function too: the kernel signal is long-lived (it belongs
 * to the registry), so a listener left behind on every completed run is an
 * unbounded leak (review v3 ROB-1).
 */
function combineAbortSignals(
  clientSignal: AbortSignal | undefined,
  kernelSignal: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (clientSignal === undefined) {
    return { signal: kernelSignal, cleanup: () => undefined };
  }
  if (clientSignal.aborted || kernelSignal.aborted) {
    return {
      signal: clientSignal.aborted ? clientSignal : kernelSignal,
      cleanup: () => undefined,
    };
  }
  const controller = new AbortController();
  const forward = (): void => controller.abort();
  // once:true so neither listener outlives the run it belongs to (review W8).
  clientSignal.addEventListener('abort', forward, { once: true });
  kernelSignal.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      // Idempotent by construction: removing a listener that already fired (and
      // was thus already detached) is a no-op.
      clientSignal.removeEventListener('abort', forward);
      kernelSignal.removeEventListener('abort', forward);
    },
  };
}

/**
 * Did this throw come from the abort signal rather than from a real write
 * failure? atomic.ts rejects with `signal.reason` (or a plain Error('aborted'))
 * when it discards the temp file (SPEC §4.6.2). The signal must be the MERGED
 * one: a sidecar that dies during the write aborts that but not the client's
 * (review v3 ROB-8 item 6).
 */
/** Guards the failure-path write-back against running twice for one run. */
interface AbortState {
  writtenBack: boolean;
}

/**
 * Terminal error for a run that was cut short (cancelled / kernel_died). The
 * completed cells are written back exactly once per run and reported in the
 * error detail, so a failed run still tells the caller what it did
 * (SPEC §4.8 rules 3/5, review R3/W3).
 */
async function failedRunError(
  code: 'cancelled' | 'kernel_died',
  message: string,
  executed: readonly ExecutedCell[],
  deps: RunDeps,
  abortState: AbortState,
  notebook: NotebookFile,
  req: RunRequest,
  platform: NodeJS.Platform,
  executedCellsSet: ReadonlySet<number>,
  preRunDoc: NotebookDoc,
  /**
   * Warnings this run had already gathered, and the mime values it dropped.
   *
   * Without them this exit reported `warnings: []` for a run whose FILE had already been
   * rewritten and whose values had already been discarded — the model was told nothing
   * was lost (review v10 V10-7). The timeout exit has taken this route since v9; the
   * aborted/kernel-died exits were left behind, and their comment claimed otherwise.
   */
  collected: { warnings: readonly Warning[]; droppedMimes: readonly DroppedMime[] } = {
    warnings: [],
    droppedMimes: [],
  },
): Promise<IpynbError> {
  // The failure-path write-back can discover carried-forward content, and the
  // caller here is an ERROR response: without this collector the warning had
  // nowhere to go and the failure detail simply claimed `warnings: []` (review v6
  // WARN-CODE-1 — the run path never delivered it at all).
  const warnings: Warning[] = [];
  const writeBack = abortState.writtenBack
    ? { performed: false, backup_path: null }
    : await writeBackCompleted(notebook, req, deps, platform, executedCellsSet, warnings, preRunDoc);
  abortState.writtenBack = true;
  // Same assembly as the successful and timeout exits, so the three terminal shapes
  // cannot disagree about what the run lost.
  const assembled = assembleCallWarnings(executed, collected.droppedMimes);
  for (const warning of [...collected.warnings, ...assembled]) {
    if (!warnings.some((existing) => existing.message === warning.message)) {
      warnings.push(createWarning(warning.code, warning.message));
    }
  }
  return new IpynbError(code, message, {
    executed_cells: executed.length,
    executed: executed as unknown as JsonValue,
    write_back: writeBack,
    // Projected to the wire shape: warnings is a returned field, and the detail
    // must stay JSON-safe.
    warnings: warnings.map((warning) => ({ code: warning.code, message: warning.message })),
  });
}

/**
 * Failure-path write-back (SPEC §4.7 rule 5, §4.8 rule 3). A failing write
 * must NOT replace the primary outcome: the caller is reporting
 * exec_timeout/cancelled/kernel_died, and a `file_changed` or
 * `notebook_locked` from here would hide exactly the error the model needs
 * (review W3). The failure is reported through `write_back.reason` and a
 * warning instead.
 */
async function writeBackCompleted(
  notebook: NotebookFile,
  req: RunRequest,
  deps: RunDeps,
  platform: NodeJS.Platform,
  executedCellsSet: ReadonlySet<number>,
  /** Collector for warnings that must reach the caller (see failedRunError). */
  warnings: Warning[] = [],
  preRunDoc?: NotebookDoc,
): Promise<RunOutcome['write_back']> {
  if (!req.writeOutputs || executedCellsSet.size === 0) {
    return { performed: false, backup_path: null };
  }
  try {
    const partialWrite = await writeNotebookFile(notebook, req.path, {
      hasher: deps.hasher,
      backupKeep: deps.config.backupKeep,
      createBackup: req.createBackup,
      expectedContentHash: notebook.contentHash,
      // Deliberately NOT passing req.abort.signal here: this write-back IS the
      // abort handling (SPEC §4.8 rule 3 — completed cells are written back
      // when a run dies), so an already-aborted signal must not block it.
      platform,
      onCleanupError: (message) => deps.logger?.warn(message),
      // Same scope rule as the main write-back (review v5 GATE-1), and the same
      // duty to report what was preserved.
      touchedCellIndexes: executedCellsSet,
      ...(preRunDoc === undefined ? {} : { originalDoc: preRunDoc }),
      onStructuralWarning: (message) => {
        warnings.push(createWarning(PREEXISTING_CONTENT_WARNING, message));
        deps.logger?.warn(message);
      },
    });
    return { performed: true, backup_path: partialWrite.backupPath };
  } catch (cause) {
    const reason = cause instanceof IpynbError ? cause.code : String(cause);
    deps.logger?.warn(`write-back of already-completed cells failed (${reason}) for ${req.path}`);
    return { performed: false, backup_path: null, reason };
  }
}

