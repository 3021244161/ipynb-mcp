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

/** Which cells a write is responsible for (review v5 GATE-1). */
export interface SelfCheckScope {
  /**
   * Cells this write actually changed, by index in the document being written.
   * `undefined` means "the whole document", which is only correct when the
   * caller is creating the document rather than editing an existing one.
   */
  readonly touchedCellIndexes?: ReadonlySet<number>;
  /**
   * Called with a problem that was ALREADY in the document, i.e. one this write
   * is carrying forward rather than introducing. Reporting it instead of failing
   * is what keeps a file with historical quirks editable (review v5 GATE-1).
   */
  readonly onPreExistingProblem?: (problem: Record<string, JsonValue>) => void;
  /**
   * The document as it was BEFORE this write, when the caller can supply it. It
   * answers the question a refusal has to be able to answer — "did this write
   * introduce the problem, or was it already there?" (AGENTS §9) — so the
   * rejection detail can say `pre_existing: true` and point at the escape hatch
   * instead of reading like "we broke your file" (review v6 SCOPE-REFUSE-HINT).
   */
  readonly originalDoc?: NotebookDoc;
  /**
   * Cells whose `outputs` this write EMPTIED (`clear_outputs`), by index.
   *
   * The cell-level `execution_count` rules are about a count that belongs to a set
   * of outputs. Once the operation under judgement has removed those outputs, the
   * rule has nothing left to be about — and refusing anyway made the recommended
   * escape hatch fail with the very error it was recommended for: `clear_outputs`
   * was refused by `execution_count_negative` because the count is not in the
   * outputs it clears, so the model was told to run an operation that could not
   * succeed (review v8 V8-14).
   *
   * SPEC §4.5 rule 5 forbids `clear_outputs` from touching `execution_count`, so the
   * fix belongs here rather than in the operation: the check is ours, the operation
   * is the specification's.
   */
  readonly clearedOutputCellIndexes?: ReadonlySet<number>;
}

/**
 * Pre-write self check (SPEC §5.5.5): re-parse the bytes we are about to write
 * with the same parser, then check the structural rules for the cells this write
 * changed. Any failure aborts the write (selfcheck_failed).
 *
 * The re-parse alone is NOT enough, and that is not a theoretical gap: it
 * accepted `outputType`-shaped outputs and markdown cells carrying
 * `execution_count`, so two independent write paths silently produced files that
 * `nbformat.validate` rejects — with `write_back.performed: true` and no warning
 * (review v4 FID-1/FID-3/FID-4).
 *
 * The SCOPE is equally load-bearing (review v5 GATE-1). Checking the whole
 * document means the gate judges the user's INPUT as well as our output, and a
 * file that already contains something we dislike — a `display_data` without
 * `metadata`, written years ago by another tool — makes every edit and every run
 * fail forever with `selfcheck_failed` naming a cell the caller never touched.
 * Refusing to write protects the file but destroys the product, so the gate is
 * limited to cells this write is responsible for, and pre-existing problems are
 * reported as a warning instead (see `structuralWarning`).
 */
export function selfCheckNotebook(
  serialized: string,
  hasher: Hasher,
  scope: SelfCheckScope = {},
): NotebookFile {
  const parsed = requireParsed(serialized, hasher);
  const problem = findStructuralProblem(
    parsed.doc,
    scope.touchedCellIndexes,
    scope.clearedOutputCellIndexes,
  );
  if (problem !== null) {
    // A refusal must be able to say whether it is refusing OUR output or the
    // user's pre-existing content (AGENTS §9), and it must point at the escape
    // hatch: only `clear_outputs` or `set_cell_type` can remove the offending
    // value, and a model that is not told that has no way forward
    // (review v6 SCOPE-REFUSE-HINT).
    const before =
      scope.originalDoc === undefined
        ? null
        : findStructuralProblem(scope.originalDoc, scope.touchedCellIndexes, scope.clearedOutputCellIndexes);
    const sameProblem =
      before !== null &&
      String(before['rule']) === String(problem['rule']) &&
      before['cell_index'] === problem['cell_index'];
    throw new IpynbError('selfcheck_failed', 'serialized notebook failed the nbformat structure check', {
      problem: problem as JsonValue,
      ...(sameProblem
        ? {
            pre_existing: true,
            hint: `this cell already violated ${String(problem['rule'])} before the change; ${escapeHatchFor(problem)}`,
          }
        : { pre_existing: false }),
    });
  }
  if (scope.onPreExistingProblem !== undefined) {
    // Same bytes, second look, wider scope: the caller already paid for the
    // parse, so reporting carried-forward content costs one scan and not a
    // second parse.
    const preExisting = findStructuralProblem(parsed.doc);
    if (preExisting !== null) {
      scope.onPreExistingProblem(preExisting);
    }
  }
  return parsed;
}

/**
 * A pre-existing structural problem, as a warning rather than a refusal
 * (review v5 GATE-1 suggestion ③). The model is told the file has content this
 * tool would not have written, without being locked out of editing it.
 */
export function structuralWarning(problem: Record<string, JsonValue>): string {
  const cell = typeof problem['cell_index'] === 'number' ? ` at cell ${String(problem['cell_index'])}` : '';
  const rule = String(problem['rule']);
  // Describes the FILE, and only the file. The first version ended with "the
  // requested change was applied", which is a claim about the request this
  // function knows nothing about — and it is emitted before the write lands, so a
  // later `notebook_locked` left a log line asserting success (review v6
  // WARN-CODE-1 附带).
  //
  // The message starts with a FIXED, machine-readable prefix because the warning
  // code is borrowed: §7's `file_changed_externally` means "an external change was
  // detected", which is not what happened here — the content was always like this.
  // A client that branches on the code would otherwise discard CAS state or retry
  // for a file nobody touched (review v7 WARN-CODE-2 / D-041).
  return `pre-existing-content: notebook already contained nbformat content this tool would not write (${rule}${cell}); it was preserved rather than rewritten`;
}

/**
 * The operation that actually clears a refused rule, named for that rule.
 *
 * The hint used to recommend `clear_outputs` for everything, and after the
 * `execution_count` rule was added that recommendation was wrong for it: the cell
 * count is not in the outputs, `clear_outputs` did not touch it, and the recommended
 * operation was refused by the same rule — leaving `set_cell_type` as the only exit
 * while the model was told to try the other one (review v8 V8-14). A hint is a
 * promise; it may only name operations that work.
 *
 * `clear_outputs` now resets the count as well, so both entries below are true. The
 * mapping stays explicit rather than generic because the next rule added will not
 * necessarily be cleared by either operation.
 */
function escapeHatchFor(problem: Record<string, JsonValue>): string {
  const rule = String(problem['rule']);
  if (rule === 'execution_count_negative' || rule === 'non_code_cell_has_execution_count') {
    return 'clear_outputs resets the cell execution count, and set_cell_type removes it by changing the cell type';
  }
  if (rule === 'non_code_cell_has_outputs') {
    return 'set_cell_type converts the cell so the outputs are no longer stored on it';
  }
  return 'clear_outputs removes the outputs this rule is about, and set_cell_type removes them by changing the cell type';
}

/** The fixed prefix {@link structuralWarning} puts on its message (D-041). */
export const PREEXISTING_CONTENT_PREFIX = 'pre-existing-content: ';

function requireParsed(serialized: string, hasher: Hasher): NotebookFile {
  try {
    return parseNotebook(new TextEncoder().encode(serialized), hasher);
  } catch (cause) {
    if (cause instanceof IpynbError && cause.code === 'nbformat_unsupported') {
      throw new IpynbError('selfcheck_failed', 'serialized notebook failed self check', { cause: cause.code });
    }
    throw new IpynbError('selfcheck_failed', 'serialized notebook failed self check', {
      cause: String(cause),
    });
  }
}

/**
 * The nbformat minor version whose schema this project implements (4.5). Above
 * it, nbformat's validator relaxes `additionalProperties` and accepts
 * unrecognized output and cell types, and this gate follows suit so it never
 * rejects what the authority accepts (review v5 GATE-2).
 */
export const SUPPORTED_NBFORMAT_MINOR = 5;

/**
 * The smallest set of nbformat structural rules this codebase can actually
 * violate. Deliberately not a schema validator: every rule corresponds to a
 * file shape the write paths produce or could produce, and it reports the FIRST
 * problem it finds.
 *
 * Two boundaries, both of which the first version got wrong (review v5
 * GATE-1/2/3) and which the README now states out loud:
 *
 *  - **Scope comes from the caller.** This function looks at the whole document
 *    because it cannot know what a write touched; `selfCheckNotebook` decides
 *    which cells that answer applies to. Checking every cell of the INPUT turned
 *    a pre-existing quirk anywhere in the user's file into a permanently
 *    read-only notebook: every edit and every run failed with `selfcheck_failed`
 *    pointing at a cell the caller never touched.
 *  - **nbformat's own leniency is part of the rules.** For `nbformat_minor`
 *    above the schema this project targets, `nbformat.validator` relaxes
 *    `additionalProperties` and adds `unrecognized_output` / `unrecognized_cell`
 *    to its oneOf — "notebooks from the future" are valid. Rejecting what the
 *    authority accepts is a false positive that GATE-1 then turns into a
 *    permanent lockout.
 */
export function findStructuralProblem(
  doc: NotebookDoc,
  touchedCellIndexes?: ReadonlySet<number>,
  /** Cells whose outputs this write emptied; see SelfCheckScope. */
  clearedOutputCellIndexes?: ReadonlySet<number>,
): Record<string, JsonValue> | null {
  const lenientKinds = doc.nbformat_minor > SUPPORTED_NBFORMAT_MINOR;
  for (let index = 0; index < doc.cells.length; index += 1) {
    // GATE-1: only the cells this write is responsible for can fail the write.
    if (touchedCellIndexes !== undefined && !touchedCellIndexes.has(index)) {
      continue;
    }
    const cell = doc.cells[index];
    if (cell === undefined) {
      continue;
    }
    if (cell.cell_type !== 'code') {
      if (lenientKinds) {
        continue;
      }
      // nbformat: markdown/raw cells have NEITHER outputs NOR execution_count.
      if (cell.outputs !== undefined) {
        return { cell_index: index, rule: 'non_code_cell_has_outputs', cell_type: cell.cell_type };
      }
      if (cell.execution_count !== undefined) {
        return { cell_index: index, rule: 'non_code_cell_has_execution_count', cell_type: cell.cell_type };
      }
      continue;
    }
    // Cell-level `execution_count` (review v7 P1-a). The gate checked the copy
    // INSIDE an `execute_result` output but not the cell's own field, so a cell
    // with `execution_count: -1` — which nbformat rejects ("-1 is less than the
    // minimum of 0") — stayed writable and the file stayed invalid after a
    // successful edit, contradicting D-037's "a rewritten cell that still carries
    // a problem is still refused".
    //
    // Checked before `outputs` is required, because a cell with no `outputs` key at
    // all still carries the count.
    // Skipped when THIS operation emptied the cell outputs. SPEC §4.5 rule 5
    // keeps `execution_count` out of `clear_outputs` reach, so a cell that had a
    // negative count still has one afterwards — and refusing the operation that
    // removed the outputs this count belongs to made the recommended escape hatch
    // fail with the same error it was recommended for (review v8 V8-14).
    const outputsWereCleared =
      clearedOutputCellIndexes !== undefined && clearedOutputCellIndexes.has(index);
    if (!outputsWereCleared && cell.execution_count !== undefined && cell.execution_count !== null) {
      if (!Number.isInteger(cell.execution_count) || cell.execution_count < 0) {
        return { cell_index: index, rule: 'execution_count_negative', execution_count: cell.execution_count };
      }
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
      const problem = outputProblem(outputType, record, index, position, lenientKinds);
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
  lenientKinds: boolean,
): Record<string, JsonValue> | null {
  const where = { cell_index: cellIndex, output_index: outputIndex, output_type: outputType };
  switch (outputType) {
    case 'stream': {
      // nbformat's schema types `name` as a plain STRING (no enum), and
      // `nbformat.validate` accepts "foo". Demanding stdout/stderr here rejected
      // files the authority accepts, which made such a cell permanently
      // uneditable — the same class of over-refusal as GATE-1, at cell scale
      // (review v6 GATE-6). Normalizing the two known names is the WRITE
      // direction's job and already happens in `nbformatOutputsOfRaw`.
      if (typeof record['name'] !== 'string') {
        return { ...where, rule: 'stream_name_not_a_string' };
      }
      const text = record['text'];
      if (typeof text === 'string') {
        return null;
      }
      if (!Array.isArray(text)) {
        return { ...where, rule: 'stream_text_missing' };
      }
      // nbformat allows a list of strings, not a list of anything.
      if (!text.every((entry) => typeof entry === 'string')) {
        return { ...where, rule: 'stream_text_element_not_a_string' };
      }
      return null;
    }
    case 'error': {
      for (const field of ['ename', 'evalue', 'traceback']) {
        if (record[field] === undefined) {
          return { ...where, rule: 'error_field_missing', field };
        }
      }
      if (typeof record['ename'] !== 'string' || typeof record['evalue'] !== 'string') {
        return { ...where, rule: 'error_field_not_a_string' };
      }
      return stringArrayProblem(record, 'traceback', where);
    }
    case 'execute_result': {
      // nbformat requires execution_count HERE and only here: this is the rule
      // a bare `outputType` -> `output_type` rename would still violate. Its
      // TYPE matters too — presence alone accepted `"3"`, which nbformat
      // rejects, so the gate was looser than the authority (GATE-3).
      if (!('execution_count' in record)) {
        return { ...where, rule: 'execute_result_execution_count_missing' };
      }
      const count = record['execution_count'];
      if (count !== null && !Number.isInteger(count)) {
        return { ...where, rule: 'execute_result_execution_count_not_an_integer' };
      }
      // The schema also sets `minimum: 0`; a negative count is invalid and was
      // accepted (review v6 GATE-5, same family).
      if (typeof count === 'number' && count < 0) {
        return { ...where, rule: 'execute_result_execution_count_negative' };
      }
      return dataProblem(record, where);
    }
    case 'display_data':
      return dataProblem(record, where);
    default:
      // nbformat accepts unrecognized output types for minor versions beyond the
      // schema it validated against (GATE-2).
      return lenientKinds ? null : { ...where, rule: 'unknown_output_type' };
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
  // A mime VALUE must be a string or an array of strings, and checking only that
  // `data` is an object let the kernel smuggle any JSON value through: a plain
  // user cell (`display({'text/plain': 5}, raw=True)`) produced a file
  // `nbformat.validate` rejects while the run reported write_back.performed and
  // no warning — the FID-1 failure mode with the entry point moved from the field
  // NAME to the value TYPE (review v6 GATE-5, reproduced with a real kernel).
  for (const [mime, value] of Object.entries(data as Record<string, unknown>)) {
    // nbformat allows ANY type for JSON mime types: the value IS the document.
    if (isJsonMime(mime)) {
      continue;
    }
    if (isRepresentableMimeValue(value)) {
      continue;
    }
    return { ...where, rule: 'output_data_value_not_a_string', mime };
  }
  const metadata = record['metadata'];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { ...where, rule: 'output_metadata_missing' };
  }
  return null;
}

/**
 * Whether a mime KEY may hold an arbitrary JSON value.
 *
 * The pattern is nbformat's OWN `patternProperties` key, verbatim:
 * `^application/(.*\+)?json$`. Writing it as `(?:[^/]+\+)?json` looked equivalent
 * and was not — it required a non-empty subtype without a slash, so
 * `application/x/y+json` and `application/+json`, both of which nbformat accepts,
 * were rejected and their values dropped or refused (review v7 V7-10, the mirror
 * image of GATE-6: too strict, so legal data is lost).
 *
 * The execution path needs the same rule the write gate enforces — one definition,
 * so the two cannot disagree (review v6 GATE-5).
 */
const JSON_MIME = /^application\/(.*\+)?json$/;

export function isJsonMime(mime: string): boolean {
  return JSON_MIME.test(mime);
}

/**
 * Whether a mime VALUE is representable in nbformat: a string, or an array of
 * strings. Shared with the execution path for the same reason as {@link isJsonMime}.
 */
export function isRepresentableMimeValue(value: unknown): boolean {
  return typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

/** nbformat types every element of these arrays as a string. */
function stringArrayProblem(
  record: Record<string, unknown>,
  field: string,
  where: Record<string, JsonValue>,
): Record<string, JsonValue> | null {
  const value = record[field];
  if (!Array.isArray(value)) {
    return { ...where, rule: `${field}_not_an_array`, field };
  }
  if (!value.every((entry) => typeof entry === 'string')) {
    // `["ok", 5]` is rejected by nbformat; accepting it wrote a file Jupyter
    // would refuse (review v6 GATE-5, same family as the mime values).
    return { ...where, rule: `${field}_element_not_a_string`, field };
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
