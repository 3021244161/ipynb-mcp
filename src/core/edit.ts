// Cell editing engine (SPEC §4.5): CAS double anchors, per-op field matrix,
// sequential application on the in-memory model with "current coordinates".
// Any failing op aborts the whole request; the caller must not write the file.

import {
  IpynbError,
  createWarning,
  type JsonValue,
  type Warning,
} from './errors.js';
import type { MarkdownIssue } from './markdown.js';
import {
  cellSource,
  cellSourceHash,
  setCellSource,
  type Hasher,
  type NotebookCell,
  type NotebookFile,
} from './parse.js';

/** Raw op as it arrives from JSON — fields are narrowed defensively inside. */
export type EditOpInput = Readonly<Record<string, unknown>>;

export type { MarkdownIssue } from './markdown.js';

export interface ChangedCell {
  readonly cell_index: number;
  readonly cell_id: string | null;
  readonly new_line_count: number;
  readonly new_source_hash: string;
  readonly outputs_cleared: boolean;
  /**
   * Whether this op rewrote the cell's CONTENT (`source`/`outputs`/`cell_type`).
   * A pure `move_cell` repositions a cell without touching a byte of it, so it
   * must not be treated as "we wrote this cell" — otherwise reordering a
   * notebook that contains a quirk elsewhere refuses the whole request and the
   * only escape is to destroy the user's output (review v6 SCOPE-REFUSE-HINT).
   */
  readonly content_changed: boolean;
}

export interface EditResult {
  readonly applied: number;
  readonly changedCells: ChangedCell[];
  readonly warnings: Warning[];
  readonly markdownIssues: MarkdownIssue[];
}

export interface EditOptions {
  readonly hasher: Hasher;
  readonly nbformatMinor: number;
  /** Markdown structural checker (SPEC §5.7); absent = no checking. */
  readonly checkMarkdown?: (source: string) => MarkdownIssue[];
}

interface OpMatrixRow {
  /** Required fields (excluding the locator pair and anchors, handled separately). */
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
  /** op needs cell_id or cell_index to locate an existing cell. */
  readonly requiresLocator: boolean;
  /** replace_lines: expected_text mandatory. */
  readonly requiresTextAnchor: boolean;
  /** insert_lines: expected_before + expected_after mandatory. */
  readonly requiresInsertNeighbors: boolean;
  /** replace_source / delete_cell / set_cell_type: hash or text anchor required. */
  readonly requiresHashOrText: boolean;
}

const ALL_ANCHORS = ['expected_text', 'expected_before', 'expected_after', 'expected_source_hash'] as const;

const MATRIX: Readonly<Record<string, OpMatrixRow>> = {
  replace_lines: {
    required: ['op', 'start_line', 'end_line', 'new_text'],
    forbidden: ['at_line', 'at_index', 'source', 'cell_type'],
    requiresLocator: true,
    requiresTextAnchor: true,
    requiresInsertNeighbors: false,
    requiresHashOrText: false,
  },
  insert_lines: {
    required: ['op', 'at_line', 'new_text'],
    forbidden: ['start_line', 'end_line', 'at_index', 'source', 'cell_type'],
    requiresLocator: true,
    requiresTextAnchor: false,
    requiresInsertNeighbors: true,
    requiresHashOrText: false,
  },
  replace_source: {
    required: ['op', 'new_text'],
    forbidden: ['start_line', 'end_line', 'at_line', 'at_index', 'source', 'cell_type'],
    requiresLocator: true,
    requiresTextAnchor: false,
    requiresInsertNeighbors: false,
    requiresHashOrText: true,
  },
  insert_cell: {
    required: ['op', 'at_index', 'cell_type', 'source'],
    forbidden: ['cell_id', 'cell_index', 'from_index', 'to_index', ...ALL_ANCHORS, 'new_text', 'start_line', 'end_line', 'at_line'],
    requiresLocator: false,
    requiresTextAnchor: false,
    requiresInsertNeighbors: false,
    requiresHashOrText: false,
  },
  delete_cell: {
    required: ['op'],
    forbidden: ['new_text', 'source', 'cell_type', 'at_index'],
    requiresLocator: true,
    requiresTextAnchor: false,
    requiresInsertNeighbors: false,
    requiresHashOrText: true,
  },
  move_cell: {
    required: ['op', 'from_index', 'to_index'],
    forbidden: ['cell_id', 'cell_index', ...ALL_ANCHORS, 'new_text', 'source', 'cell_type', 'at_index'],
    requiresLocator: false,
    requiresTextAnchor: false,
    requiresInsertNeighbors: false,
    requiresHashOrText: false,
  },
  set_cell_type: {
    required: ['op', 'cell_type'],
    forbidden: ['new_text', 'source', 'at_index'],
    requiresLocator: true,
    requiresTextAnchor: false,
    requiresInsertNeighbors: false,
    requiresHashOrText: true,
  },
  clear_outputs: {
    required: ['op'],
    forbidden: ['new_text', 'source', 'cell_type', 'at_index'],
    requiresLocator: true,
    requiresTextAnchor: false,
    requiresInsertNeighbors: false,
    requiresHashOrText: false,
  },
};

const MAX_DETAIL_TEXT = 4000;

export function applyEditOps(
  notebook: NotebookFile,
  ops: readonly EditOpInput[],
  options: EditOptions,
): EditResult {
  const warnings: Warning[] = [];
  const markdownIssues: MarkdownIssue[] = [];
  const touchedCells: NotebookCell[] = [];
  /** Cells whose CONTENT this request rewrote (a pure move is not one). */
  const contentTouched = new Set<NotebookCell>();
  const clearedOutputs = new Set<NotebookCell>();
  // First (not last) count-changing op: later structural ops must not reset
  // the scan window, or index ops between two structural ops go unwarned
  // (SPEC §4.1.9, review A8).
  let firstStructureChangeOpIndex = -1;
  let noStableIdWarned = false;

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const raw = ops[opIndex] ?? {};
    const kind = readOpName(raw, opIndex);
    // The cell this op targets, resolved by the branch itself. Tracking it here
    // instead of re-locating it afterwards also removes a second locate() per
    // op (a linear cell_id search) and a branch that could never be reached
    // (review v3 QUAL-7).
    let touchedCell: NotebookCell | undefined;
    const row = MATRIX[kind];
    if (row === undefined) {
      throw invalidOps(opIndex, kind, `unknown op: ${kind}`);
    }
    validateMatrix(raw, row, opIndex, kind);

    const usesCellIndex = raw['cell_index'] !== undefined;

    switch (kind) {
      case 'replace_lines': {
        const cell = locate(notebook, raw, opIndex);
        const startLine = readIndexField(raw, 'start_line', opIndex);
        const endLine = readIndexField(raw, 'end_line', opIndex);
        const newText = readStringField(raw, 'new_text', opIndex)!;
        const lines = cellSource(cell).split('\n');
        if (startLine < 1 || endLine < startLine || endLine > lines.length) {
          throw rangeOutOfBounds(opIndex, kind, `start_line ${startLine}..end_line ${endLine} out of range 1..${lines.length}`);
        }
        checkOptionalHashAnchor(notebook, cell, raw, options, opIndex);
        const actualRangeText = lines.slice(startLine - 1, endLine).join('\n');
        const userAnchor = readStringField(raw, 'expected_text', opIndex)!;
        checkTextAnchor(notebook, cell, userAnchor, actualRangeText, 'line_text', opIndex, options);
        lines.splice(startLine - 1, endLine - startLine + 1, ...newText.split('\n'));
        setCellSource(cell, lines.join('\n'));
        trackMarkdownWrite(cell, kind, options, markdownIssues);
        touchedCell = cell;
        break;
      }
      case 'insert_lines': {
        const cell = locate(notebook, raw, opIndex);
        const atLine = readIndexField(raw, 'at_line', opIndex);
        const newText = readStringField(raw, 'new_text', opIndex)!;
        const lines = cellSource(cell).split('\n');
        if (atLine < 1 || atLine > lines.length + 1) {
          throw rangeOutOfBounds(opIndex, kind, `at_line ${atLine} out of range 1..${lines.length + 1}`);
        }
        checkOptionalHashAnchor(notebook, cell, raw, options, opIndex);
        const beforeExpected = readStringField(raw, 'expected_before', opIndex)!;
        const afterExpected = readStringField(raw, 'expected_after', opIndex)!;
        const actualBefore = atLine === 1 ? '' : (lines[atLine - 2] ?? '');
        const actualAfter = atLine === lines.length + 1 ? '' : (lines[atLine - 1] ?? '');
        if (beforeExpected !== actualBefore || afterExpected !== actualAfter) {
          throw casMismatch(notebook, opIndex, 'insert_neighbors', cell, options, {
            before: beforeExpected,
            after: afterExpected,
          }, {
            before: actualBefore,
            after: actualAfter,
          });
        }
        lines.splice(atLine - 1, 0, ...newText.split('\n'));
        setCellSource(cell, lines.join('\n'));
        trackMarkdownWrite(cell, kind, options, markdownIssues);
        touchedCell = cell;
        break;
      }
      case 'replace_source': {
        const cell = locate(notebook, raw, opIndex);
        const newText = readStringField(raw, 'new_text', opIndex)!;
        checkAnchorsHashOrText(notebook, cell, raw, options, opIndex);
        if (cell.cell_type === 'markdown' && newText.length > cellSource(cell).length * 1.5) {
          pushOnce(warnings, createWarning(
            'large_markdown_rewrite',
            `markdown rewrite at cell index ${notebook.cells.indexOf(cell)} grows the source beyond 1.5x; consider insert_lines/replace_lines instead`,
          ));
        }
        setCellSource(cell, newText);
        trackMarkdownWrite(cell, kind, options, markdownIssues);
        touchedCell = cell;
        break;
      }
      case 'insert_cell': {
        const atIndex = readIndexField(raw, 'at_index', opIndex);
        const cellType = readCellType(raw, opIndex);
        const source = readStringField(raw, 'source', opIndex)!;
        if (atIndex < 0 || atIndex > notebook.cells.length) {
          throw rangeOutOfBounds(opIndex, kind, `at_index ${atIndex} out of range 0..${notebook.cells.length}`);
        }
        const cell = createCell(cellType, source, options.nbformatMinor, notebook);
        notebook.cells.splice(atIndex, 0, cell);
        trackCell(touchedCells, contentTouched, cell);
        if (firstStructureChangeOpIndex < 0) {
          firstStructureChangeOpIndex = opIndex;
        }
        trackMarkdownWrite(cell, kind, options, markdownIssues);
        touchedCell = cell;
        break;
      }
      case 'delete_cell': {
        const cell = locate(notebook, raw, opIndex);
        checkAnchorsHashOrText(notebook, cell, raw, options, opIndex);
        notebook.cells.splice(notebook.cells.indexOf(cell), 1);
        if (firstStructureChangeOpIndex < 0) {
          firstStructureChangeOpIndex = opIndex;
        }
        break;
      }
      case 'move_cell': {
        const fromIndex = readIndexField(raw, 'from_index', opIndex);
        const toIndex = readIndexField(raw, 'to_index', opIndex);
        const count = notebook.cells.length;
        if (fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count) {
          throw rangeOutOfBounds(opIndex, kind, `from_index ${fromIndex}/to_index ${toIndex} out of range 0..${count - 1}`);
        }
        const [moved] = notebook.cells.splice(fromIndex, 1);
        notebook.cells.splice(toIndex, 0, moved!);
        trackMovedCell(touchedCells, moved!);
        if (options.nbformatMinor < 5 && !noStableIdWarned) {
          noStableIdWarned = true;
          pushOnce(warnings, createWarning(
            'no_stable_cell_id',
            'notebook has no stable cell ids (nbformat_minor < 5); indexes shift when cells are added or removed',
          ));
        }
        break;
      }
      case 'set_cell_type': {
        const cell = locate(notebook, raw, opIndex);
        const cellType = readCellType(raw, opIndex);
        checkAnchorsHashOrText(notebook, cell, raw, options, opIndex);
        cell.cell_type = cellType;
        if (cellType === 'markdown') {
          // SPEC §4.5 write rule 4: outputs and execution_count are DELETED,
          // not nulled. A markdown cell with `execution_count: null` is invalid
          // nbformat ("Additional properties are not allowed"), and
          // serializeNotebook only fills the key for code cells, so the residue
          // stayed in the user's file forever (review v4 FID-3).
          delete cell.outputs;
          delete cell.execution_count;
        } else if (cellType === 'code') {
          if (cell.outputs === undefined) {
            cell.outputs = [];
          }
          if (cell.execution_count === undefined) {
            cell.execution_count = null;
          }
        }
        trackMarkdownWrite(cell, kind, options, markdownIssues);
        touchedCell = cell;
        break;
      }
      case 'clear_outputs': {
        const cell = locate(notebook, raw, opIndex);
        if (cell.cell_type !== 'code') {
          // markdown/raw cells have no outputs (SPEC §5.5.6): writing
          // cell.outputs on them would corrupt the nbformat (review A9).
          throw invalidOps(opIndex, kind, `clear_outputs requires a code cell (cell ${notebook.cells.indexOf(cell)} is ${cell.cell_type})`);
        }
        // Anchors are optional extra checks here (SPEC §4.5 matrix).
        checkOptionalHashAnchor(notebook, cell, raw, options, opIndex);
        const text = readStringField(raw, 'expected_text', opIndex);
        if (text !== undefined) {
          checkTextAnchor(notebook, cell, text, cellSource(cell), 'line_text', opIndex, options);
        }
        cell.outputs = [];
        // NOTE: `execution_count` is deliberately NOT touched — SPEC §4.5 rule 5 is
        // explicit ("clear_outputs 只清 outputs，不动 execution_count、不动源码").
        // The v8 V8-14 fix therefore lives in the GATE: a cell whose outputs this
        // operation just removed is not judged by the cell-level `execution_count`
        // rule, because that rule and the outputs it belongs to are gone.
        //
        // It must STAY that way for the fix to hold. The rule is applied on every
        // later write too — it asks whether the cell's outputs were emptied by the
        // write under judgement — so a model that follows the hint and edits the cell
        // again is not refused, and the count it was told about is still in the file
        // exactly as SPEC §4.5 rule 5 requires (review v9 V9-8 pins both halves).
        clearedOutputs.add(cell);
        touchedCell = cell;
        break;
      }
      default: {
        throw new IpynbError('internal', `unhandled op kind: ${kind}`);
      }
    }

    if (usesCellIndex && options.nbformatMinor < 5 && !noStableIdWarned) {
      noStableIdWarned = true;
      pushOnce(warnings, createWarning(
        'no_stable_cell_id',
        'notebook has no stable cell ids (nbformat_minor < 5); indexes shift when cells are added or removed',
      ));
    }

    if (touchedCell !== undefined) {
      trackCell(touchedCells, contentTouched, touchedCell);
    }
  }

  // index_shifted: a count-changing op followed by an op using cell_index (SPEC §4.1.9).
  if (firstStructureChangeOpIndex >= 0) {
    for (let i = firstStructureChangeOpIndex + 1; i < ops.length; i += 1) {
      const raw = ops[i] ?? {};
      if (raw['cell_index'] !== undefined) {
        pushOnce(warnings, createWarning(
          'index_shifted',
          `cell indexes in later ops refer to the model after earlier insert/delete ops (first at op ${firstStructureChangeOpIndex})`,
        ));
        break;
      }
    }
  }

  // Markdown gate: any error-severity issue fails the whole request (SPEC §4.5 rule 3).
  if (markdownIssues.some((issue) => issue.severity === 'error')) {
    throw new IpynbError('markdown_invalid', 'markdown check failed', {
      issues: markdownIssues as unknown as JsonValue,
    });
  }

  const changedCells: ChangedCell[] = touchedCells.map((cell) => ({
    cell_index: notebook.cells.indexOf(cell),
    cell_id: cell.id ?? null,
    new_line_count: cellSource(cell).split('\n').length,
    new_source_hash: cellSourceHash(cell, options.hasher),
    outputs_cleared: clearedOutputs.has(cell),
    content_changed: contentTouched.has(cell),
  })).filter((entry) => entry.cell_index >= 0);

  return { applied: ops.length, changedCells, warnings, markdownIssues };
}

// ---------------------------------------------------------------------------
// Matrix validation & field narrowing
// ---------------------------------------------------------------------------

function readOpName(raw: EditOpInput, opIndex: number): string {
  const value = raw['op'];
  if (typeof value !== 'string') {
    throw invalidOps(opIndex, '<unknown>', 'op field must be a string');
  }
  return value;
}

function validateMatrix(raw: EditOpInput, row: OpMatrixRow, opIndex: number, kind: string): void {
  for (const field of row.required) {
    if (raw[field] === undefined) {
      throw invalidOps(opIndex, kind, `missing required field: ${field}`);
    }
  }
  for (const field of row.forbidden) {
    if (raw[field] !== undefined) {
      throw invalidOps(opIndex, kind, `field must not appear: ${field}`);
    }
  }
  if (row.requiresLocator && raw['cell_id'] === undefined && raw['cell_index'] === undefined) {
    throw invalidOps(opIndex, kind, 'requires cell_id or cell_index');
  }
  if (row.requiresTextAnchor && raw['expected_text'] === undefined) {
    throw invalidOps(opIndex, kind, 'requires expected_text');
  }
  if (
    row.requiresInsertNeighbors &&
    (raw['expected_before'] === undefined || raw['expected_after'] === undefined)
  ) {
    throw invalidOps(opIndex, kind, 'requires expected_before and expected_after');
  }
  if (
    row.requiresHashOrText &&
    raw['expected_source_hash'] === undefined &&
    raw['expected_text'] === undefined
  ) {
    throw invalidOps(opIndex, kind, 'requires expected_source_hash or expected_text');
  }
  // Defensive type narrowing (schema-level typing happens at the tool layer;
  // anything malformed that slips through is a matrix violation, not internal).
  for (const [field, value] of Object.entries(raw)) {
    const expected = fieldType(field);
    if (expected === 'string' && typeof value !== 'string') {
      throw invalidOps(opIndex, kind, `field ${field} must be a string`);
    }
    if (expected === 'integer' && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
      throw invalidOps(opIndex, kind, `field ${field} must be a non-negative integer`);
    }
    if (expected === 'cell_type' && value !== 'code' && value !== 'markdown') {
      throw invalidOps(opIndex, kind, `field cell_type must be 'code' or 'markdown'`);
    }
  }
}

function fieldType(field: string): 'string' | 'integer' | 'cell_type' | 'ignored' {
  switch (field) {
    case 'op':
      return 'ignored';
    case 'cell_type':
      return 'cell_type';
    case 'cell_id':
    case 'expected_text':
    case 'expected_before':
    case 'expected_after':
    case 'expected_source_hash':
    case 'new_text':
    case 'source':
      return 'string';
    case 'cell_index':
    case 'start_line':
    case 'end_line':
    case 'at_line':
    case 'at_index':
    case 'from_index':
    case 'to_index':
      return 'integer';
    default:
      return 'ignored';
  }
}

function readStringField(raw: EditOpInput, field: string, opIndex: number): string | undefined {
  const value = raw[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidOps(opIndex, String(raw['op']), `field ${field} must be a string`);
  }
  return value;
}

function readIndexField(raw: EditOpInput, field: string, opIndex: number): number {
  const value = raw[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidOps(opIndex, String(raw['op']), `field ${field} must be a non-negative integer`);
  }
  return value;
}

function readCellType(raw: EditOpInput, opIndex: number): 'code' | 'markdown' {
  const value = raw['cell_type'];
  if (value !== 'code' && value !== 'markdown') {
    throw invalidOps(opIndex, String(raw['op']), `field cell_type must be 'code' or 'markdown'`);
  }
  return value;
}

function locate(notebook: NotebookFile, raw: EditOpInput, opIndex: number): NotebookCell {
  const cellId = raw['cell_id'];
  if (cellId !== undefined) {
    if (typeof cellId !== 'string') {
      throw invalidOps(opIndex, String(raw['op']), 'field cell_id must be a string');
    }
    const index = notebook.cells.findIndex((cell) => cell.id === cellId);
    if (index < 0) {
      throw new IpynbError('cell_not_found', `cell_id not found: ${cellId}`, {
        failed_op_index: opIndex,
        cell_id: cellId,
      });
    }
    return notebook.cells[index]!;
  }
  const index = readIndexField(raw, 'cell_index', opIndex);
  const cell = notebook.cells[index];
  if (cell === undefined) {
    throw new IpynbError('cell_not_found', `cell_index out of range: ${index}`, {
      failed_op_index: opIndex,
      cell_index: index,
      cell_count: notebook.cells.length,
    });
  }
  return cell;
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

function checkOptionalHashAnchor(notebook: NotebookFile, cell: NotebookCell, raw: EditOpInput, options: EditOptions, opIndex: number): void {
  const expected = readStringField(raw, 'expected_source_hash', opIndex);
  if (expected === undefined) {
    return;
  }
  const actual = cellSourceHash(cell, options.hasher);
  if (expected !== actual) {
    throw casMismatch(notebook, opIndex, 'source_hash', cell, options, expected, actual);
  }
}

function checkAnchorsHashOrText(notebook: NotebookFile, cell: NotebookCell, raw: EditOpInput, options: EditOptions, opIndex: number): void {
  const expectedHash = readStringField(raw, 'expected_source_hash', opIndex);
  const expectedText = readStringField(raw, 'expected_text', opIndex);
  const actualHash = cellSourceHash(cell, options.hasher);
  if (expectedHash !== undefined && expectedHash !== actualHash) {
    throw casMismatch(notebook, opIndex, 'source_hash', cell, options, expectedHash, actualHash);
  }
  if (expectedText !== undefined && expectedText !== cellSource(cell)) {
    throw casMismatch(notebook, opIndex, 'line_text', cell, options, expectedText, cellSource(cell));
  }
}

function checkTextAnchor(
  notebook: NotebookFile,
  cell: NotebookCell,
  expected: string,
  actual: string,
  anchor: 'line_text' | 'source_hash',
  opIndex: number,
  options: EditOptions,
): void {
  if (expected !== actual) {
    throw casMismatch(notebook, opIndex, anchor, cell, options, expected, actual);
  }
}

function casMismatch(
  notebook: NotebookFile,
  opIndex: number,
  anchor: 'line_text' | 'source_hash' | 'insert_neighbors',
  cell: NotebookCell,
  options: EditOptions,
  expected: JsonValue,
  actual: JsonValue,
): IpynbError {
  const currentSource = cellSource(cell);
  // Computed once: truncateText walks the whole source, and a large cell paid
  // for that walk twice on every anchor mismatch (review v3 QUAL-7).
  const truncatedSource = truncateText(currentSource);
  return new IpynbError('cas_mismatch', 'compare-and-swap anchor mismatch', {
    failed_op_index: opIndex,
    anchor,
    cell_index: notebook.cells.indexOf(cell),
    cell_id: cell.id ?? null,
    expected: truncate(expected),
    actual: truncate(actual),
    current_source_hash: cellSourceHash(cell, options.hasher),
    current_source: truncatedSource.text,
    current_source_truncated: truncatedSource.truncated,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalidOps(opIndex: number, kind: string, reason: string): IpynbError {
  return new IpynbError('invalid_ops', `invalid op at index ${opIndex} (${kind}): ${reason}`, {
    failed_op_index: opIndex,
    op: kind,
    reason,
  });
}

function rangeOutOfBounds(opIndex: number, kind: string, reason: string): IpynbError {
  return new IpynbError('range_out_of_bounds', `out-of-range value in op at index ${opIndex} (${kind}): ${reason}`, {
    failed_op_index: opIndex,
    op: kind,
    reason,
  });
}

function truncate(value: JsonValue): JsonValue {
  if (typeof value === 'string' && value.length > MAX_DETAIL_TEXT) {
    return `${value.slice(0, MAX_DETAIL_TEXT)}…`;
  }
  return value;
}

function truncateText(value: string): { text: string; truncated: boolean } {
  if (value.length > MAX_DETAIL_TEXT) {
    return { text: `${value.slice(0, MAX_DETAIL_TEXT)}…`, truncated: true };
  }
  return { text: value, truncated: false };
}

function pushOnce(warnings: Warning[], warning: Warning): void {
  if (!warnings.some((existing) => existing.code === warning.code)) {
    warnings.push(warning);
  }
}

function trackCell(
  touchedCells: NotebookCell[],
  contentTouched: Set<NotebookCell>,
  cell: NotebookCell,
): void {
  if (!touchedCells.includes(cell)) {
    touchedCells.push(cell);
  }
  // Any op routed through here rewrites the cell bytes; `trackMovedCell` is the
  // one that only repositions.
  contentTouched.add(cell);
}

/**
 * Track a cell that was only REPOSITIONED. `move_cell` cannot change a cell's
 * bytes, so it must not join the set the write gate treats as "ours" — doing so
 * refused whole reorder requests over a quirk in the moved cell and left the user
 * with `clear_outputs` as the only way forward (review v6 SCOPE-REFUSE-HINT).
 */
function trackMovedCell(touchedCells: NotebookCell[], cell: NotebookCell): void {
  if (!touchedCells.includes(cell)) {
    touchedCells.push(cell);
  }
}

function createCell(
  cellType: 'code' | 'markdown',
  source: string,
  nbformatMinor: number,
  notebook: NotebookFile,
): NotebookCell {
  const cell: NotebookCell =
    cellType === 'code'
      ? { cell_type: 'code', metadata: {}, outputs: [], execution_count: null }
      : { cell_type: cellType, metadata: {} };
  setCellSource(cell, source);
  if (nbformatMinor >= 5) {
    cell.id = uniqueCellId(notebook);
  }
  return cell;
}

/** Deterministic unique id (no RNG in core, R10/R11): 'inserted-<n>' skipping collisions. */
function uniqueCellId(notebook: NotebookFile): string {
  const existing = new Set(notebook.cells.map((cell) => cell.id).filter((id): id is string => typeof id === 'string'));
  let n = 1;
  while (existing.has(`inserted-${n}`)) {
    n += 1;
  }
  return `inserted-${n}`;
}

function trackMarkdownWrite(
  cell: NotebookCell,
  kind: string,
  options: EditOptions,
  markdownIssues: MarkdownIssue[],
): void {
  const isMarkdownWrite =
    cell.cell_type === 'markdown' &&
    (kind === 'replace_source' || kind === 'replace_lines' || kind === 'insert_lines' || kind === 'insert_cell' || kind === 'set_cell_type');
  if (!isMarkdownWrite || options.checkMarkdown === undefined) {
    return;
  }
  const issues = options.checkMarkdown(cellSource(cell));
  for (const issue of issues) {
    markdownIssues.push(issue);
  }
}
