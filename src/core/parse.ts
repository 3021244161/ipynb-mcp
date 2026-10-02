// Notebook parsing & serialization (SPEC §5.5). Pure logic: the model holds
// the *original* parsed JSON tree and edits mutate that tree in place (R1);
// untouched cells keep their original `source` shape (string stays string,
// array stays array) byte-for-byte after a round trip.

import { IpynbError, type JsonValue } from './errors.js';

export interface Hasher {
  sha256Hex(input: string | Uint8Array): string;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  /** Present when nbformat_minor >= 5. */
  id?: string;
  source?: string | string[];
  outputs?: unknown[];
  execution_count?: number | null;
  metadata: Record<string, unknown>;
  // Unknown cell-level fields are preserved verbatim.
  [key: string]: unknown;
}

export interface NotebookDoc {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
  // Unknown top-level fields are preserved verbatim.
  [key: string]: unknown;
}

export interface NotebookFile {
  /** The original parsed document; edits mutate this tree in place (R1). */
  readonly doc: NotebookDoc;
  /** Reference to doc.cells (same objects). */
  readonly cells: NotebookCell[];
  /** sha256 of the raw bytes this file was parsed from (SPEC §4.1.6). */
  readonly contentHash: string;
}

export function parseNotebook(rawBytes: Uint8Array, hasher: Hasher): NotebookFile {
  const contentHash = `sha256:${hasher.sha256Hex(rawBytes)}`;
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch (cause) {
    throw new IpynbError('parse_failed', 'notebook file is not valid JSON', {
      cause: String(cause),
    });
  }
  if (!isPlainObject(doc)) {
    throw new IpynbError('parse_failed', 'notebook root is not a JSON object', {});
  }
  const nbformat = doc['nbformat'];
  if (typeof nbformat !== 'number' || !Number.isInteger(nbformat)) {
    throw new IpynbError('parse_failed', 'notebook has no integer nbformat field', {});
  }
  if (nbformat < 4) {
    throw new IpynbError('nbformat_unsupported', `nbformat ${nbformat} is below the supported major version 4`, {
      nbformat,
    });
  }
  const cells = doc['cells'];
  if (!Array.isArray(cells)) {
    throw new IpynbError('parse_failed', 'notebook has no cells array', {});
  }
  for (const [index, cell] of cells.entries()) {
    if (!isPlainObject(cell)) {
      throw new IpynbError('parse_failed', `cell at index ${index} is not an object`, { cell_index: index });
    }
    const cellType = cell['cell_type'];
    if (cellType !== 'code' && cellType !== 'markdown' && cellType !== 'raw') {
      throw new IpynbError('parse_failed', `cell at index ${index} has an invalid cell_type`, {
        cell_index: index,
        cell_type: String(cellType),
      });
    }
  }
  return {
    doc: doc as unknown as NotebookDoc,
    cells: cells as NotebookCell[],
    contentHash,
  };
}

/** Cell source normalized to a single string (SPEC §5.5.3, read direction). */
export function cellSource(cell: NotebookCell): string {
  const source: unknown = cell.source;
  if (typeof source === 'string') {
    return source;
  }
  if (Array.isArray(source)) {
    return source.join('');
  }
  return '';
}

/** Write direction: modified cells store their source as a string array (Jupyter convention). */
export function sourceToArray(source: string): string[] {
  if (source === '') {
    return [];
  }
  // Each element keeps its trailing newline except the final line, matching
  // Jupyter's own serialization ('a\nb' -> ['a\n','b']; 'a\n' -> ['a\n']).
  return source.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** Mutate a cell's source on the original tree; array form per SPEC §5.5.3. */
export function setCellSource(cell: NotebookCell, source: string): void {
  cell.source = sourceToArray(source);
}

/** `source_hash` per SPEC §4.1.7: sha256 over the merged source string. */
export function cellSourceHash(cell: NotebookCell, hasher: Hasher): string {
  return `sha256:${hasher.sha256Hex(cellSource(cell))}`;
}

/** Serialize with Jupyter's 1-space indent and trailing newline (SPEC §5.5.4). */
export function serializeNotebook(notebook: NotebookFile): string {
  // SPEC §5.5.6: code cells without execution_count get null on write.
  for (const cell of notebook.cells) {
    if (cell.cell_type === 'code' && cell.execution_count === undefined) {
      cell.execution_count = null;
    }
  }
  return `${JSON.stringify(notebook.doc, null, 1)}\n`;
}

/**
 * Pre-write self check (SPEC §5.5.5): re-parse the bytes we are about to
 * write with the same parser. Any failure aborts the write (selfcheck_failed).
 *
 * The re-parse alone is NOT enough, and that is not a theoretical gap: it
 * accepted `outputType`-shaped outputs and markdown cells carrying
 * `execution_count`, so two independent write paths silently produced files
 * that `nbformat.validate` rejects — with `write_back.performed: true` and no
 * warning (review v4 FID-1/FID-3/FID-4). The structural gate below runs on the
 * same bytes that are about to land, so "不会静默改坏" is a statement about the
 * RESULT rather than about the parser (SPEC §6 R2/R9).
 */
export function selfCheckNotebook(serialized: string, hasher: Hasher): NotebookFile {
  let parsed: NotebookFile;
  try {
    parsed = parseNotebook(new TextEncoder().encode(serialized), hasher);
  } catch (cause) {
    if (cause instanceof IpynbError && cause.code === 'nbformat_unsupported') {
      throw new IpynbError('selfcheck_failed', 'serialized notebook failed self check', { cause: cause.code });
    }
    throw new IpynbError('selfcheck_failed', 'serialized notebook failed self check', {
      cause: String(cause),
    });
  }
  const problem = findStructuralProblem(parsed.doc);
  if (problem !== null) {
    throw new IpynbError('selfcheck_failed', 'serialized notebook failed the nbformat structure check', {
      problem: problem as JsonValue,
    });
  }
  return parsed;
}

/**
 * The smallest set of nbformat structural rules this codebase can actually
 * violate. Deliberately not a full schema validation (that is nbformat's job
 * and would need a dependency): every rule corresponds to a file shape that
 * the write paths have produced or could produce.
 *
 * Returns a JSON-safe detail object, or null when the document is acceptable.
 */
export function findStructuralProblem(doc: NotebookDoc): Record<string, JsonValue> | null {
  for (let index = 0; index < doc.cells.length; index += 1) {
    const cell = doc.cells[index];
    if (cell === undefined) {
      continue;
    }
    if (cell.cell_type !== 'code') {
      // nbformat: markdown/raw cells have NEITHER outputs NOR execution_count.
      if (cell.outputs !== undefined) {
        return { cell_index: index, rule: 'non_code_cell_has_outputs', cell_type: cell.cell_type };
      }
      if (cell.execution_count !== undefined) {
        return { cell_index: index, rule: 'non_code_cell_has_execution_count', cell_type: cell.cell_type };
      }
      continue;
    }
    const outputs = cell.outputs;
    if (outputs === undefined) {
      continue;
    }
    if (!Array.isArray(outputs)) {
      return { cell_index: index, rule: 'outputs_not_an_array' };
    }
    for (let position = 0; position < outputs.length; position += 1) {
      const output = outputs[position];
      if (typeof output !== 'object' || output === null || Array.isArray(output)) {
        return { cell_index: index, output_index: position, rule: 'output_not_an_object' };
      }
      const record = output as Record<string, unknown>;
      const outputType = record['output_type'];
      if (typeof outputType !== 'string') {
        // The exact shape the sidecar protocol uses (`outputType`) lands here.
        return {
          cell_index: index,
          output_index: position,
          rule: 'output_type_missing',
          saw: 'outputType' in record ? 'outputType' : 'missing',
        };
      }
      const problem = outputProblem(outputType, record, index, position);
      if (problem !== null) {
        return problem;
      }
    }
  }
  return null;
}

function outputProblem(
  outputType: string,
  record: Record<string, unknown>,
  cellIndex: number,
  outputIndex: number,
): Record<string, JsonValue> | null {
  const where = { cell_index: cellIndex, output_index: outputIndex, output_type: outputType };
  switch (outputType) {
    case 'stream': {
      if (record['name'] !== 'stdout' && record['name'] !== 'stderr') {
        return { ...where, rule: 'stream_name_invalid' };
      }
      const text = record['text'];
      if (typeof text !== 'string' && !Array.isArray(text)) {
        return { ...where, rule: 'stream_text_missing' };
      }
      return null;
    }
    case 'error': {
      for (const field of ['ename', 'evalue', 'traceback']) {
        if (record[field] === undefined) {
          return { ...where, rule: 'error_field_missing', field };
        }
      }
      if (!Array.isArray(record['traceback'])) {
        return { ...where, rule: 'error_traceback_not_an_array' };
      }
      return null;
    }
    case 'execute_result': {
      // nbformat requires execution_count HERE and only here: this is the rule
      // a bare `outputType` -> `output_type` rename would still violate.
      if (!('execution_count' in record)) {
        return { ...where, rule: 'execute_result_execution_count_missing' };
      }
      return dataProblem(record, where);
    }
    case 'display_data':
      return dataProblem(record, where);
    default:
      return { ...where, rule: 'unknown_output_type' };
  }
}

function dataProblem(
  record: Record<string, unknown>,
  where: Record<string, JsonValue>,
): Record<string, JsonValue> | null {
  const data = record['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ...where, rule: 'output_data_missing' };
  }
  const metadata = record['metadata'];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { ...where, rule: 'output_metadata_missing' };
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Notebook metadata projection (D15/B4): single source for the three
 *  consumers (run orchestration, kernel tool, read rendering). */
export interface NotebookMetadataInfo {
  readonly kernelName: string | null;
  readonly languageName: string | null;
  readonly languageVersion: string | null;
}

export function readNotebookMetadata(doc: NotebookDoc): NotebookMetadataInfo {
  const metadata = doc.metadata as Record<string, unknown>;
  const kernelspec = metadata['kernelspec'];
  const languageInfo = metadata['language_info'];
  const pick = (record: unknown, field: string): string | null => {
    if (typeof record !== 'object' || record === null) {
      return null;
    }
    const value = (record as Record<string, unknown>)[field];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return {
    kernelName: pick(kernelspec, 'name'),
    languageName: pick(languageInfo, 'name'),
    languageVersion: pick(languageInfo, 'version'),
  };
}

/**
 * Whether cells carry stable ids (nbformat_minor >= 5, SPEC §4.1.11). Lives
 * here because it is a fact about the format, not about the text projection
 * (review v3 ARCH-1).
 */
export function hasStableCellIds(doc: NotebookDoc): boolean {
  return doc.nbformat_minor >= 5;
}
