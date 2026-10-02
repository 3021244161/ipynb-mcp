// Execution orchestration (SPEC §4.7): selector parsing, the mode matrix,
// sequential cell execution with replay's silent prefix, output mapping and
// the guarded write-back. This module composes core/fs/kernel pieces; it is
// exposed to MCP tools in step 9.

import { IpynbError, createWarning, type JsonValue, type Warning } from './core/errors.js';
import { mapRawOutputs, type OutputItem } from './core/outputs.js';
import { cellSource, readNotebookMetadata, type Hasher, type NotebookFile } from './core/parse.js';
import { analyzeStale, downgradeConfidence, regexDefs, regexUses, type StaleCell } from './core/stale.js';
import type { IpynbConfig } from './config.js';
import { applyImagePolicy, shouldReturnImages, type ImagesPolicy } from './fs/artifact.js';
import { readNotebookFile, writeNotebookFile } from './fs/notebook-file.js';
import type { KernelRegistry } from './kernel/registry.js';
import { resolveForNotebook } from './kernel/interpreter.js';
import type { Logger } from './log.js';

export type RunMode = 'auto' | 'resume' | 'replay' | 'full';
export type ModeUsed = 'resume' | 'replay' | 'full';

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
  readonly write_back: { performed: boolean; backup_path: string | null };
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
      const rawStart = parts[0];
      const rawEnd = parts[1];
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
  const hasLiveKernel = deps.registry.findByNotebook(req.path) !== null;
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

  // Ensure the kernel exists (getOrCreate is idempotent per reuse key).
  const session = await deps.registry.getOrCreate({
    notebookPath: req.path,
    interpreterPath: resolution.interpreterPath,
    kernelSpecName: resolution.kernelSpecName,
    language: resolution.language,
    // replay must rebuild state on a NEW kernel (SPEC §4.7 matrix, review A4):
    // reusing a live one would leave stale variables masking prefix failures.
    fresh: modeUsed === 'replay',
  });

  // Run-level lock (review A6 / SPEC §10.2 I10): a second concurrent run on
  // the same kernel raises kernel_busy instead of interleaving cells.
  const releaseRun = deps.registry.acquireRun(req.path);
  try {
    deps.onProgress?.({ phase: 'start', total: targets.length });

    // ---- replay prefix: silent, no outputs, no counters, nothing written ------
    for (const index of replayPrefix) {
      if (isAborted(req.abort)) {
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

    // ---- execution loop --------------------------------------------------------
    // clear_outputs_before applies per cell, immediately before that cell runs:
    // pre-clearing the whole target set would wipe outputs of cells that never
    // execute when a timeout/cancel interrupts the run (SPEC §4.7 rule 3).
    const executed: ExecutedCell[] = [];
    const imageBlocks: RunImageBlock[] = [];
    const executedCellsSet = new Set<number>();
    // Running cursor so image_index stays unique across the whole call
    // (SPEC §4.3), not reset per cell (review A5).
    let imageCursor = 0;
    let sawTimeout = false;

    for (const index of targets) {
      if (isAborted(req.abort)) {
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
      try {
        result = await deps.registry.execCell(req.path, {
          code: cellSource(cell),
          silent: false,
          storeOutputs: true,
          timeoutMs: req.timeoutSeconds * 1000,
        });
      } catch (cause) {
        cell.outputs = savedOutputs;
        cell.execution_count = savedCount;
        if (isAborted(req.abort)) {
          // The kernel was killed while this cell was in flight (restart/
          // shutdown raced the execution): fall through to the abort branch so
          // completed cells still get written back (SPEC §4.8 rule 3).
          break;
        }
        throw cause;
      }
      const mapped = mapRawOutputs(result.result.rawOutputs, {
        inlineTextChars: deps.config.inlineTextChars,
        maxImageBytes: deps.config.maxImageBytes,
        hasher: deps.hasher,
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
        // items and rawOutputs are index-aligned (each raw output maps to
        // exactly one item), so the base64 payload sits at the same index.
        const rawOutput = result.result.rawOutputs[materialized.outputIndex];
        const base64 = rawOutput?.data?.[image.media_type];
        if (base64 !== undefined) {
          imageBlocks.push({ data: base64, media_type: image.media_type });
        }
      }

      executed.push({
        cell_index: index,
        cell_id: cell.id ?? null,
        status: result.result.status,
        duration_ms: result.result.durationMs,
        execution_count: result.result.executionCount,
        outputs: mapped.items,
      });

      if (result.result.status === 'timeout') {
        // Half-finished outputs of the interrupted cell never reach the file:
        // restore the pre-run outputs instead (SPEC §4.7 rule 5 / §4.8 rule 2).
        cell.outputs = savedOutputs;
        cell.execution_count = savedCount;
        sawTimeout = true;
        break;
      }

      // A cell interrupted by the abort (status error) is NOT a completed cell:
      // its partial output never lands (SPEC §4.8 rule 2). Cells that finished
      // cleanly (ok) still count, even if the abort raced in afterwards.
      const abortedNow = isAborted(req.abort);
      const interruptedByAbort = abortedNow && result.result.status === 'error';
      if (!interruptedByAbort) {
        cell.outputs = [...result.result.rawOutputs];
        cell.execution_count = result.result.executionCount;
        executedCellsSet.add(index);
      } else {
        cell.outputs = savedOutputs;
        cell.execution_count = savedCount;
      }
      if (abortedNow) {
        break;
      }
    }

    if (sawTimeout) {
      // Write back the cells that DID complete (SPEC §4.7 rule 5), then raise
      // exec_timeout with the partial state in detail.
      const timeoutWriteBack = await writeBackCompleted(notebook, req, deps, platform, executedCellsSet);
      const timeoutCell = executed[executed.length - 1];
      throw new IpynbError('exec_timeout', `cell execution timed out after ${req.timeoutSeconds}s (interrupt did not land)`, {
        cell_index: timeoutCell?.cell_index ?? null,
        completed_cells: executed.length - 1,
        // ExecutedCell is structurally JSON-safe; the cast bridges it to the
        // JsonValue union so failed-run status can report what actually ran.
        executed: executed as unknown as JsonValue,
        write_back: timeoutWriteBack,
      });
    }

    if (isAborted(req.abort)) {
      // Completed cells stay written; the interrupted cell never lands (SPEC §4.8).
      const abortWriteBack = await writeBackCompleted(notebook, req, deps, platform, executedCellsSet);
      const code = req.abort!.reason === 'kernel_died' ? 'kernel_died' : 'cancelled';
      throw new IpynbError(code, `run aborted (${code})`, {
        executed_cells: executed.length,
        executed: executed as unknown as JsonValue,
        write_back: abortWriteBack,
      });
    }

    if (mappedTruncated(executed)) {
      warnings.push(createWarning(
        'output_truncated',
        'at least one output exceeded inline_text_chars and was truncated',
      ));
    }

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
      // Map code-index-aligned arrays onto full cell-index space.
      const defs: string[][] = [];
      const uses: string[][] = [];
      for (let i = 0; i < notebook.cells.length; i += 1) {
        const codePosition = codeCellIndexes.indexOf(i);
        if (codePosition >= 0) {
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
    deps.onProgress?.({ phase: 'write_back', completed: executed.length, total: targets.length });
    let writeBack: RunOutcome['write_back'] = { performed: false, backup_path: null };
    let contentHashAfter: string | null = null;
    if (req.writeOutputs && executedCellsSet.size > 0) {
      const writeResult = await writeNotebookFile(notebook, req.path, {
        hasher: deps.hasher,
        backupKeep: deps.config.backupKeep,
        createBackup: req.createBackup,
        expectedContentHash: notebook.contentHash,
        platform,
      });
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
}

// ---------------------------------------------------------------------------

function isAborted(abort: RunRequest['abort']): boolean {
  return abort?.signal.aborted === true;
}

async function writeBackCompleted(
  notebook: NotebookFile,
  req: RunRequest,
  deps: RunDeps,
  platform: NodeJS.Platform,
  executedCellsSet: ReadonlySet<number>,
): Promise<RunOutcome['write_back']> {
  if (!req.writeOutputs || executedCellsSet.size === 0) {
    return { performed: false, backup_path: null };
  }
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
  });
  return { performed: true, backup_path: partialWrite.backupPath };
}

function mappedTruncated(executed: readonly ExecutedCell[]): boolean {
  return executed.some((entry) =>
    entry.outputs.some((output) => output.kind === 'stream' && output.truncated),
  );
}
