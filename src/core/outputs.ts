// Output mapping (SPEC §5.4): raw kernel outputs -> model-friendly OutputItems.
// Order of checks is fixed and first-match-wins; every raw output yields
// exactly 0 or 1 items. Pure logic — base64 decoding uses the global atob,
// image headers are parsed by hand (no image libraries, SPEC §4.4).

import type { JsonValue } from './errors.js';
import { decodeBase64ToBytes, encodeBase64, isBase64Shaped } from './base64.js';
import { isExactNumber } from './json-exact.js';
// Value types are imported, not redefined: the execution path and the write gate
// must answer "is this representable?" identically (review v6 GATE-5).
import { isJsonMime, isRepresentableMimeValue, type Hasher, type NotebookCell } from './parse.js';

/** Raw output as delivered by the sidecar protocol (SPEC §5.8, + metadata for §4.4). */
export interface RawOutput {
  outputType: 'stream' | 'display_data' | 'execute_result' | 'error';
  /**
   * Mime-keyed values.
   *
   * `unknown`, not `string`: nbformat's `application/json` (and every `+json`
   * mime) may hold ANY JSON value, and the schema says so explicitly — the read
   * direction used to run every value through `String()`/`JSON.parse`, which
   * turned a legal `[1,2,3]` into `123` and dropped objects, numbers, `null` and
   * booleans entirely, all with no warning. Claiming `string` here was the lie
   * that let it happen (review v7 V7-1). Every other mime type is still a string
   * or an array of strings; `mapRawOutputs` narrows per mime.
   */
  data?: Record<string, unknown>;
  text?: string;
  name?: 'stdout' | 'stderr';
  ename?: string;
  evalue?: string;
  traceback?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Set by {@link rawOutputsOfCell} when a stored output had an unknown
   * `output_type`: the entry is surfaced as `unsupported` instead of being
   * dropped, so "this cell has no outputs" is never a false claim (FID-2).
   */
  unsupportedKind?: string;
}

/**
 * nbformat stores multi-line strings in `data` either as a string or as an
 * array of lines (both are valid, and Jupyter writes arrays). Joining mirrors
 * what the stream/`text` branch has always done; silently dropping the array
 * form lost real outputs (review v3 ARCH-1).
 */
/**
 * A text-bearing mime value as a string, or null when it cannot be one.
 *
 * `text/*` mimes are declared by nbformat as "string or array of strings", so
 * the type is a contract — but the type we hold says `unknown`, because the
 * SAME field carries `application/json` (any JSON value). Narrowing here rather
 * than asserting keeps a hostile/garbled value out of a `text: string` field:
 * `display({'text/plain': 5}, raw=True)` used to come back as `text: 5`
 * (review v7 P1-b).
 */
function mimeText(value: unknown): string | null {
  return dataValueToString(value);
}

/**
 * The mime keys this tool treats as images (SPEC §4.4). Shared by the read boundary and
 * the image branch so "which keys are images" has one answer.
 */
function isImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg';
}

/**
 * A base64-carrying mime value as a string, or null when it is not one.
 *
 * STRICTER than {@link dataValueToString}, and the difference is the whole point of the
 * function existing (review v10, V9-1 residue). nbformat allows a mime value to be a
 * string OR an array of strings, and both are legal for an image; but a mime value may
 * also be any JSON value in practice, and `[1,2,3]` (or `{...}`) reaching a `String()`
 * map produces `"123"` — which is valid base64 alphabet, decodes to two bytes, and was
 * therefore served as a REAL IMAGE, artifact and all, with no warning. The read path and
 * the run path also disagreed: the read path joined an array of lines and produced an
 * image, while the run path — where the value arrives from the sidecar unjoined — called
 * the same value "not a string" and degraded it.
 *
 * So the rule is one rule for both paths: join ONLY when every element is a string; in
 * every other case return null and let the documented degradation happen.
 */
function imageValueText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.join('');
  }
  return null;
}

function dataValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join('');
  }
  return null;
}

/**
 * nbformat cell outputs -> RawOutput[], the ONLY place that knows the nbformat
 * output shape (SPEC §4.1.1: conversion happens at the parse boundary, D15).
 * The mcp projection layer calls this instead of parsing outputs itself
 * (review v3 ARCH-1 / AGENTS §4 module rule).
 */
export function rawOutputsOfCell(cell: NotebookCell): RawOutput[] {
  const outputs = cell.outputs;
  if (!Array.isArray(outputs)) {
    return [];
  }
  const mapped: RawOutput[] = [];
  for (const entry of outputs) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const outputType = record['output_type'];
    if (
      outputType !== 'stream' &&
      outputType !== 'error' &&
      outputType !== 'execute_result' &&
      outputType !== 'display_data'
    ) {
      // Unknown output kinds cannot be projected into RawOutput (nbformat has
      // no catch-all shape). They are counted, not silently dropped: the read
      // path reports them as `unsupported` so a cell never looks empty when it
      // is merely unreadable (review v4 FID-2 — the old behaviour reported
      // "no outputs", which is a false claim and hid the write-back bug).
      mapped.push({ outputType: 'display_data', data: {}, unsupportedKind: String(outputType) });
      continue;
    }
    const raw: RawOutput = { outputType };
    const data = record['data'];
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        // JSON mime types carry the value ITSELF, in whatever JSON shape the
        // kernel produced — nbformat's schema allows any of them, and the write
        // gate already exempts them for exactly that reason (review v6 GATE-5).
        // Passing them through `dataValueToString` broke that contract on the read
        // side: `[1,2,3]` was joined to "1,2,3", parsed back as the number 123,
        // and objects/numbers/null/booleans were dropped with `warnings: []` — the
        // model was handed a wrong answer for legal data (review v7 V7-1).
        if (isJsonMime(key)) {
          normalized[key] = value;
          continue;
        }
        // An IMAGE mime keeps nbformat's two legal shapes distinguishable. Joining first
        // and asking questions later lost the difference between "an array of lines"
        // (legal, must work) and "an array of numbers" (not a string, must degrade):
        // `[1,2,3]` joined to `"123"`, which is valid base64 alphabet, so it was served
        // as a real 2-byte image with an artifact and no warning (review v10, V9-1
        // residue). The array of STRINGS is still joined here, so both the read path and
        // the run path hand `mapRawOutputs` the same thing.
        if (isImageMime(key)) {
          normalized[key] = Array.isArray(value) && value.every((line) => typeof line === 'string')
            ? value.join('')
            : value;
          continue;
        }
        const text = dataValueToString(value);
        // A value that cannot be a string is KEPT as `null` rather than dropped:
        // dropping the key claimed the mime was never there, so an image whose
        // value was a number came back as "unsupported output type (unknown)"
        // instead of naming `image/png` — the model's only clue about what it was
        // looking at (review v9 V9-1's matrix). The write gate still refuses to
        // store a null under a non-json mime, so nothing about the file changes.
        normalized[key] = text;
      }
      raw.data = normalized;
    }
    const text = dataValueToString(record['text']);
    if (text !== null) {
      raw.text = text;
    }
    if (record['name'] === 'stderr' || record['name'] === 'stdout') {
      raw.name = record['name'];
    }
    if (typeof record['ename'] === 'string') {
      raw.ename = record['ename'];
    }
    if (typeof record['evalue'] === 'string') {
      raw.evalue = record['evalue'];
    }
    if (Array.isArray(record['traceback'])) {
      raw.traceback = (record['traceback'] as unknown[]).map(String);
    }
    const metadata = record['metadata'];
    if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
      raw.metadata = metadata as Record<string, unknown>;
    }
    mapped.push(raw);
  }
  return mapped;
}

/**
 * RawOutput[] -> nbformat cell outputs: the write direction of
 * {@link rawOutputsOfCell}, and the reason it has to exist (review v4 FID-1).
 *
 * The sidecar speaks its OWN private shape (`outputType`, camelCase), and that
 * shape was assigned straight to `cell.outputs`. Every executed cell therefore
 * made the notebook invalid nbformat: `nbformat.validate` rejected it,
 * JupyterLab/nbconvert would refuse it or lose the output, and this tool could
 * not read back what it had just written — while reporting
 * `write_back.performed: true` and no warning.
 *
 * nbformat requires `execution_count` on `execute_result` (and only there),
 * which is why a bare rename of `outputType` is not enough.
 */
export function nbformatOutputsOfRaw(
  raws: readonly RawOutput[],
  executionCount: number | null,
): unknown[] {
  return raws.map((raw) => {
    switch (raw.outputType) {
      case 'stream':
        return {
          output_type: 'stream',
          name: raw.name === 'stderr' ? 'stderr' : 'stdout',
          text: raw.text ?? '',
        };
      case 'error':
        return {
          output_type: 'error',
          ename: raw.ename ?? '',
          evalue: raw.evalue ?? '',
          traceback: raw.traceback ?? [],
        };
      case 'execute_result':
        return {
          output_type: 'execute_result',
          data: raw.data ?? {},
          metadata: raw.metadata ?? {},
          execution_count: executionCount,
        };
      default:
        return {
          output_type: 'display_data',
          data: raw.data ?? {},
          metadata: raw.metadata ?? {},
        };
    }
  });
}

/**
 * Make stored outputs representable in nbformat, reporting what had to go.
 *
 * The write gate refuses to produce a file nbformat rejects, and that refusal is
 * correct — but refusing at write time means ALL the work in the run is lost
 * because ONE output carried a value we cannot store. A plain user cell can do
 * that (`display({'text/plain': 5}, raw=True)`), and the reviewer's reading of the
 * contract applies: abnormal output is ours to handle, not an error to hand back
 * (review v6 GATE-5 + CRASH-1; the SPEC §4.8 code list does not even contain a
 * runner for this).
 *
 * So the execution path normalizes BEFORE serializing:
 *   - a mime value that is neither a string nor an array of strings is dropped
 *     (the output keeps its other, representable mime types);
 *   - a negative `execution_count` becomes null (the schema sets `minimum: 0`).
 * The write gate stays exactly as strict, which is why a future writer that
 * forgets this step still cannot corrupt a file — it fails instead.
 */
export function dropUnrepresentableOutputs(outputs: readonly unknown[]): {
  readonly outputs: unknown[];
  readonly droppedMimes: string[];
} {
  const droppedMimes: string[] = [];
  const kept = outputs.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return entry;
    }
    const record = entry as Record<string, unknown>;
    let next = record;
    const data = record['data'];
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const filtered: Record<string, unknown> = {};
      let changed = false;
      for (const [mime, value] of Object.entries(data as Record<string, unknown>)) {
        // JSON mime types may hold anything; every other kind must be a string
        // or a list of strings.
        if (isJsonMime(mime) || isRepresentableMimeValue(value)) {
          filtered[mime] = value;
        } else {
          droppedMimes.push(mime);
          changed = true;
        }
      }
      if (changed) {
        next = { ...next, data: filtered };
      }
    }
    const count = next['execution_count'];
    if (typeof count === 'number' && count < 0) {
      next = { ...next, execution_count: null };
    }
    return next;
  });
  return { outputs: kept, droppedMimes };
}

/**
 * A cell's `execution_count` in a form nbformat accepts, or null.
 *
 * The schema sets `minimum: 0`, and the gate refuses a negative cell count in the
 * cells a write is responsible for (review v7 P1-a). The execution path therefore
 * must not write one: `execution_count: -1` can arrive from the kernel, and a
 * saved count being restored (`write_outputs: false`) can be one that was already
 * in the file.
 */
export function representableExecutionCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * A mime value that had to be dropped, and the cell it belonged to.
 *
 * The cell is part of the fact, not decoration: the warning names which cell lost
 * a value so the model can look there, and the v8 message lost that when the pairs
 * were flattened into a `string[]` — while D-042 recorded the impact as "names the
 * cell and the mime" (review v9 V9-7).
 */
export interface DroppedMime {
  readonly cellIndex: number;
  readonly mime: string;
}

/**
 * How many dropped mime values a warning names before it summarises the rest.
 *
 * The mime NAMES come from the user's cells (`display({'application/x-bogus-<i>': 5})`),
 * so an unbounded list lets a cell size the response: the reviewer measured a 9 897
 * character warning from a 300-iteration loop, which then travels into `warnings[]` and
 * into `exec_timeout`'s `detail.warnings` (review v10 V10-9). Eight is enough to name the
 * shapes a real notebook has; the count stays exact, so nothing is hidden by the cap.
 */
export const DROPPED_MIME_DETAIL_LIMIT = 8;

/**
 * The `output_truncated` warning for a call, or null when nothing was lost.
 *
 * Two different facts share this code because SPEC §7's table is closed
 * (AGENTS §11.4): a value nbformat cannot store was DROPPED, and an output was
 * TRUNCATED at `inline_text_chars`. They also share the code's one-per-call rule, so
 * whichever spoke first used to silence the other — the model would be told about
 * truncation and never learn that a value had been discarded, or the reverse
 * (review v8 V8-10).
 *
 * One message therefore carries both counts, and a third fact rides along: a
 * `+json`/`application/json` value JavaScript cannot hold exactly is reported (and
 * its exact digits preserved) by {@link collectOutputWarnings} (review v9 V9-5).
 * The text is built here, in core, so the rule is testable without a kernel and
 * cannot drift from the callers: the v7 attempt at this lived inline in `run.ts`,
 * and the test for it re-implemented the same `if` on its own array, so deleting
 * the real guard kept the suite green (review v8 V8-4).
 */
export function outputTruncatedWarning(
  dropped: readonly DroppedMime[],
  truncatedCount: number,
): { code: 'output_truncated'; message: string } | null {
  // Same cell dropping the same mime twice is one fact; the same mime dropped by
  // two cells is two, and saying so is the point of carrying the cell index.
  const seen = new Set<string>();
  const unique: DroppedMime[] = [];
  for (const entry of dropped) {
    const key = `${String(entry.cellIndex)}\u0000${entry.mime}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  if (unique.length === 0 && truncatedCount === 0) {
    return null;
  }
  const parts: string[] = [];
  if (unique.length > 0) {
    const named = unique
      .slice(0, DROPPED_MIME_DETAIL_LIMIT)
      .map((entry) => `cell ${String(entry.cellIndex)}: ${entry.mime}`);
    const rest = unique.length - named.length;
    parts.push(
      `dropped ${String(unique.length)} mime value(s) nbformat cannot store (${named.join(', ')}${rest > 0 ? `, … and ${String(rest)} more` : ''})`,
    );
  }
  if (truncatedCount > 0) {
    parts.push(
      `${String(truncatedCount)} output(s) exceeded inline_text_chars and were truncated`,
    );
  }
  return { code: 'output_truncated', message: parts.join('; ') };
}

/**
 * The per-call warnings for a finished (or abandoned) run, in one place.
 *
 * Pure, and exported so a unit test can drive the REAL rule with real inputs. The v9
 * version of this logic lived inline in `run.ts` behind a private helper, and the
 * reviewer's mutation — short-circuit the helper — left all 432 unit cases green; only
 * the integration suite noticed (review v10 V10-5). A rule that only an integration test
 * can falsify is a rule most runs never check.
 *
 * `executed` carries the outputs (truncation and inexact numbers), `dropped` the mime
 * values nbformat could not store. Results are deduplicated by message and returned in a
 * stable order so two exits of the same run cannot disagree.
 */
export function assembleCallWarnings(
  executed: readonly { readonly outputs: readonly OutputItem[] }[],
  dropped: readonly DroppedMime[],
): OutputWarning[] {
  const warnings: OutputWarning[] = [];
  const seen = new Set<string>();
  const push = (warning: OutputWarning): void => {
    if (seen.has(warning.message)) {
      return;
    }
    seen.add(warning.message);
    warnings.push(warning);
  };
  const truncation = outputTruncatedWarning(dropped, countTruncatedCells(executed));
  if (truncation !== null) {
    push(truncation);
  }
  for (const lifted of collectOutputWarnings(executed)) {
    push(lifted);
  }
  return warnings;
}

/** How many executed cells had at least one truncated output. */
export function countTruncatedCells(
  cells: readonly { readonly outputs: readonly OutputItem[] }[],
): number {
  return cells.filter((cell) => cell.outputs.some(isTruncatedItem)).length;
}

/**
 * Lift per-output warnings to the call level, where SPEC §7's closed table lives.
 *
 * The output-level detail stays on the item (a model needs to know WHICH output);
 * this is what makes the same problem visible to a client that only reads
 * `warnings[]`. Deduped by message, so a call cannot report the identical fact
 * twice, and returned in first-seen order for stable output.
 */
export function collectOutputWarnings(
  cells: readonly { readonly outputs: readonly OutputItem[] }[],
): OutputWarning[] {
  const seen = new Set<string>();
  const lifted: OutputWarning[] = [];
  for (const cell of cells) {
    for (const item of cell.outputs) {
      if (item.kind !== 'json') {
        continue;
      }
      for (const warning of item.warnings) {
        if (seen.has(warning.message)) {
          continue;
        }
        seen.add(warning.message);
        lifted.push(warning);
      }
    }
  }
  return lifted;
}

function isTruncatedItem(item: OutputItem): boolean {
  return item.kind === 'stream' && item.truncated;
}

export type OutputItem =
  | { kind: 'stream'; stream_name: 'stdout' | 'stderr'; text: string; truncated: boolean; truncated_at_chars: number | null }
  | { kind: 'text'; media_type: 'text/plain'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'html'; html: string; text_fallback: string }
  | { kind: 'json'; value: JsonValue; warnings: OutputWarning[] }
  | {
      kind: 'image';
      media_type: 'image/png' | 'image/jpeg';
      width: number | null;
      height: number | null;
      bytes: number;
      artifact_path: string | null;
      image_index: number | null;
      text_fallback: string;
    }
  | { kind: 'error'; error_name: string; error_value: string; traceback_lines: string[] }
  | { kind: 'unsupported'; mime_type: string; message: string };

/**
 * A problem with ONE output value, reported next to that value.
 *
 * Output-level problems have no code of their own (SPEC §7's table is closed and
 * this project does not mint codes), and a call-level code cannot say WHICH output
 * was affected — a model that cannot locate it will rewrite the cell and destroy
 * the output. So the item carries the detail and the call-level projection lifts
 * the code up (review v9 V9-5).
 */
export interface OutputWarning {
  readonly code: 'output_truncated';
  readonly message: string;
}

/** Decoded image payload handed to the artifact layer for materialization. */
export interface ExtractedImage {
  /** Index of this image's OutputItem inside the mapped items array. */
  readonly outputIndex: number;
  readonly mediaType: 'image/png' | 'image/jpeg';
  readonly bytes: Uint8Array;
  readonly width: number | null;
  readonly height: number | null;
  readonly sha256Hex: string;
  readonly decodeFailed: boolean;
  /**
   * The payload as canonical base64 — the exact string a returned image block
   * must carry. Present exactly when `decodeFailed` is false.
   *
   * Why the block cannot read the document value instead: the value on disk may
   * be a `data:` URL, a whitespace-wrapped payload or an array joined into one
   * string, all of which DECODE fine here and none of which `atob` accepts. The
   * SDK validates `ImageContent.data` with `atob`, and a rejection is a
   * protocol-level `-32602` for the WHOLE call — the model loses the notebook,
   * not one image (review v9 V9-1). Canonicalizing once, next to the decode that
   * already happened, is the only way the two paths cannot drift again.
   */
  readonly base64: string | null;
}

export interface MapOutputsResult {
  readonly items: OutputItem[];
  readonly extractedImages: ExtractedImage[];
}

export interface MapOutputsOptions {
  readonly inlineTextChars: number;
  readonly maxImageBytes: number;
  readonly hasher: Hasher;
}

const TRACEBACK_TAIL_LINES = 20;

/**
 * A stored json-mime value as the model should see it: exactly as stored.
 *
 * nbformat puts NO type constraint on a json mime's value, so a file may legally
 * hold `null`, a boolean, a number, a STRING, an array or an object. The read
 * direction must hand back the value itself, never a re-interpretation of it.
 *
 * Two rounds got this wrong in two different ways, which is why the rule is now
 * "no conversion at all" rather than a set of special cases:
 *   - v6 and earlier ran every value through `String()` and then `JSON.parse`:
 *     `[1,2,3]` reached the model as the number 123 (v7 V7-1);
 *   - v7 fixed the non-string half and kept parsing strings, so a stored
 *     `"123"` — a JSON STRING, which nbformat is perfectly happy with — reached the
 *     model as the number 123, and `"hello"` lost its mime entirely and came back
 *     as `text/plain` (v8 V8-2).
 *
 * Both are the same failure: the model was shown a value the file does not contain.
 * A string that happens to look like JSON is still a string, and the kernel's own
 * value for a json mime is already typed (the sidecar passes `content['data']`
 * straight through), so there is nothing to parse on either path.
 *
 * SPEC §5.4 row 7's "parse failure degrades to `text`" is about a value that cannot
 * be represented as json at all; that case no longer arises here, because every JSON
 * value is now emittable as-is.
 *
 * The THIRD instance of the same family is a number that JavaScript cannot hold:
 * `parseJsonExact` keeps such a literal as a marker (review v9 V9-5), and this function
 * is where the model is told about it. The value is passed through as the number the
 * marker says, and the exact literal travels in the output's warning so the model is
 * not left believing it saw the file's value.
 *
 * RECURSIVE, because the marker can be anywhere (review v10 V10-1). The first version
 * only asked about the TOP-level value, so a literal nested in an object or an array
 * went out as the marker object itself: the model saw a structure the file does not
 * contain, no warning said why, and the marker's name is not documented anywhere. The
 * walk below replaces every marker with its number and collects one warning per
 * DISTINCT literal — the same literal twice is one fact, not two.
 */
function jsonValueOf(value: unknown): { value: JsonValue; warnings: OutputWarning[] } {
  const literals = new Map<string, number>();
  const projected = projectJsonValue(value, literals);
  const warnings: OutputWarning[] = [];
  for (const literal of literals.keys()) {
    warnings.push({ code: 'output_truncated', message: inexactNumberMessage(literal) });
  }
  return { value: projected, warnings };
}

/**
 * The one sentence that has to carry a number the JSON channel cannot.
 *
 * It states three things the model needs: the exact digits, that they are NOT what it
 * is being handed, and what it will actually read. The literal is recognisable by the
 * test suite's regex, which is why the wording is load-bearing rather than cosmetic.
 */
function inexactNumberMessage(literal: string): string {
  return `json value ${literal} was not representable exactly; the exact digits are in this warning and in the file, but a JSON client reads it as ${String(Number(literal))}`;
}

/**
 * Walk a parsed json value, replacing markers with the number they stand for.
 *
 * Ordinary objects are rebuilt rather than mutated: the tree comes from the document,
 * and the projection must not be able to change what a later write-back serializes
 * (that is the whole reason the marker exists). Keys are defined, not assigned, for the
 * same reason the parser does it — a `__proto__` key in the file is data.
 */
function projectJsonValue(value: unknown, literals: Map<string, number>): JsonValue {
  if (isExactNumber(value)) {
    const literal = value.__ipynb_exact_number__;
    literals.set(literal, (literals.get(literal) ?? 0) + 1);
    // `Number(literal)` of an out-of-range literal is Infinity, which is not a JSON
    // value: it is projected as null, which is what `JSON.stringify` does with it and
    // what the warning's wording ("reads it as …") describes. Both are lossy, and both
    // are announced.
    const asNumber = Number(literal);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    return (value ?? null) as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => projectJsonValue(entry, literals));
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // A nested `undefined` has no JSON form; `JSON.stringify` drops the key, and so do
    // we, rather than inventing a null the file does not have.
    if (entry === undefined) {
      continue;
    }
    Object.defineProperty(result, key, {
      value: projectJsonValue(entry, literals),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

export function mapRawOutputs(rawOutputs: readonly RawOutput[], options: MapOutputsOptions): MapOutputsResult {
  const items: OutputItem[] = [];
  const extractedImages: ExtractedImage[] = [];

  for (const raw of rawOutputs) {
    // 1. stream
    if (raw.outputType === 'stream') {
      const text = raw.text ?? '';
      if (text.length > options.inlineTextChars) {
        items.push({
          kind: 'stream',
          stream_name: raw.name === 'stderr' ? 'stderr' : 'stdout',
          text: text.slice(0, options.inlineTextChars),
          truncated: true,
          truncated_at_chars: options.inlineTextChars,
        });
      } else {
        items.push({
          kind: 'stream',
          stream_name: raw.name === 'stderr' ? 'stderr' : 'stdout',
          text,
          truncated: false,
          truncated_at_chars: null,
        });
      }
      continue;
    }
    // 2. error
    if (raw.outputType === 'error') {
      const traceback = raw.traceback ?? [];
      items.push({
        kind: 'error',
        error_name: raw.ename ?? '',
        error_value: raw.evalue ?? '',
        traceback_lines: traceback.slice(-TRACEBACK_TAIL_LINES),
      });
      continue;
    }
    const data = raw.data ?? {};
    // 3./4. images (png first, then jpeg).
    //
    // The value must be NARROWED before it is treated as base64. The kernel can send any
    // JSON value for a mime key, and a raw `display({'image/png': 123})` used to reach
    // `base64.replace`, throw a TypeError and abort the whole run with `internal` — a code
    // SPEC §4.8 does not list for notebook_run, from a path a user's own cell can trigger.
    // `?? ''` only caught null/undefined (review v6 CRASH-1). A value that is not a string
    // (and not an array of strings — both are legal nbformat shapes for this field) takes
    // the existing `image_materialize_failed` route, which is the documented exit for an
    // image that cannot be materialized (SPEC §4.4).
    //
    // `imageValueText` rather than a local `typeof === 'string'` check: the local version
    // made the read path and the run path disagree about the array form, and let `[1,2,3]`
    // be joined into a valid-looking base64 image (review v10, V9-1 residue).
    const imageMediaType =
      data['image/png'] !== undefined ? 'image/png' : data['image/jpeg'] !== undefined ? 'image/jpeg' : null;
    if (imageMediaType !== null) {
      const rawImage = imageValueText(data[imageMediaType]);
      // A `data:` URL is what people paste and what some tools emit. Jupyter cannot
      // render one either (`base64.b64decode` fails on the prefix), so this is not
      // legal data being dropped — but the prefix is unambiguous and stripping it is
      // both cheap and what the user meant (review v8 V8-3).
      //
      // The SAME helper builds the returned block (see `canonical` below): a value
      // that decodes here and fails `atob` at the SDK boundary used to turn one bad
      // image into `-32602` for the entire call (review v9 V9-1).
      const canonical = rawImage === null ? null : imageBlockBase64(rawImage, imageMediaType);
      if (rawImage === null || canonical === null) {
        const reason = rawImage === null ? 'image value is not a string' : imageDecodeProblem(rawImage);
        const fallback = mimeText(data['text/plain']) ?? '';
        // Register the failure so the caller emits the documented
        // `image_materialize_failed` warning. Without this entry the output would
        // be silently "an image with no artifact", which is the kind of quiet
        // degradation this project exists to avoid.
        //
        // An empty payload lands here too: `atob('')` succeeds and yields zero
        // bytes, so "empty" used to reach the model as a real image whose artifact
        // was also empty, with no warning at all (review v8 V8-3's follow-up).
        items.push({
          kind: 'image',
          media_type: imageMediaType,
          width: null,
          height: null,
          bytes: 0,
          artifact_path: null,
          image_index: null,
          text_fallback: fallback === '' ? reason : fallback,
        });
        extractedImages.push({
          outputIndex: items.length - 1,
          mediaType: imageMediaType,
          bytes: new Uint8Array(0),
          width: null,
          height: null,
          sha256Hex: options.hasher.sha256Hex(rawImage ?? ''),
          decodeFailed: true,
          base64: null,
        });
        continue;
      }
      // Cheap pre-check on the ENCODED length before decoding: base64 is 4/3 of
      // the payload, so an obviously oversized image never needs the decode
      // (which itself costs ~2.5x the image in transient copies) nor the
      // SHA-256 pass. Behaviour is unchanged — the check below still reports
      // the exact byte count for anything that gets decoded (review v3 PERF-2).
      const approxBytes = approximateBase64Bytes(canonical);
      if (approxBytes > options.maxImageBytes) {
        items.push({
          kind: 'unsupported',
          mime_type: imageMediaType,
          message: `image exceeds max_image_bytes (>= ${approxBytes} > ${options.maxImageBytes})`,
        });
        continue;
      }
      const decoded = decodeBase64(canonical);
      if (decoded !== null && decoded.byteLength > options.maxImageBytes) {
        // Oversized images become unsupported and never materialize (SPEC §4.4).
        items.push({
          kind: 'unsupported',
          mime_type: imageMediaType,
          message: `image exceeds max_image_bytes (${decoded.byteLength} > ${options.maxImageBytes})`,
        });
        continue;
      }
      const fallback = mimeText(data['text/plain']) ?? '';
      if (decoded === null) {
        // Decoding failed: stays kind:"image" with nulls; caller warns
        // image_materialize_failed (SPEC §4.4). The REASON goes in the fallback text
        // because `bytes: 0` plus a null artifact is exactly what an empty image
        // looks like, and a model that cannot tell "broken" from "empty" will
        // overwrite the output (review v8 V8-3).
        items.push({
          kind: 'image',
          media_type: imageMediaType,
          width: null,
          height: null,
          bytes: 0,
          artifact_path: null,
          image_index: null,
          text_fallback: fallback === '' ? imageDecodeProblem(rawImage) : fallback,
        });
        extractedImages.push({
          outputIndex: items.length - 1,
          mediaType: imageMediaType,
          bytes: new Uint8Array(0),
          width: null,
          height: null,
          sha256Hex: options.hasher.sha256Hex(canonical),
          decodeFailed: true,
          base64: null,
        });
        continue;
      }
      const size = imageSize(decoded, imageMediaType, raw.metadata);
      items.push({
        kind: 'image',
        media_type: imageMediaType,
        width: size?.width ?? null,
        height: size?.height ?? null,
        bytes: decoded.byteLength,
        artifact_path: null,
        image_index: null,
        text_fallback: fallback,
      });
      extractedImages.push({
        outputIndex: items.length - 1,
        mediaType: imageMediaType,
        bytes: decoded,
        width: size?.width ?? null,
        height: size?.height ?? null,
        sha256Hex: options.hasher.sha256Hex(decoded),
        decodeFailed: false,
        // Re-encoded rather than reused: `canonical` satisfies the decoder but is
        // NOT necessarily padded (`atob` accepts both), and the SDK's validator —
        // the only judge that matters — does not. Re-encoding is the identity for
        // everything it accepts, and cannot emit a string it rejects.
        base64: encodeBase64(decoded),
      });
      continue;
    }
    // 5. markdown
    if (data['text/markdown'] !== undefined) {
      items.push({ kind: 'markdown', text: mimeText(data['text/markdown']) ?? '' });
      continue;
    }
    // 6. html
    if (data['text/html'] !== undefined) {
      items.push({
        kind: 'html',
        html: mimeText(data['text/html']) ?? '',
        text_fallback: mimeText(data['text/plain']) ?? '',
      });
      continue;
    }
    // 7. json
    //
    // The KEY is found with nbformat's own json rule (`isJsonMime`), the same one
    // the write gate uses to decide the value is storable. Looking up only the
    // literal `application/json` meant every `application/<x>+json` value was legal
    // on disk (the write side kept it) and invisible to the model (the read side
    // reported `unsupported`), with nothing to say so (review v8 V8-1).
    //
    // The VALUE is emitted as it is, with no conversion at all: see
    // {@link jsonValueOf}. SPEC §5.4 row 7's "parse failure degrades to `text`" no
    // longer has a case to apply to, because every JSON value is now emittable.
    const jsonKey = Object.keys(data).find((key) => isJsonMime(key));
    if (jsonKey !== undefined) {
      const projected = jsonValueOf(data[jsonKey]);
      items.push({ kind: 'json', value: projected.value, warnings: projected.warnings });
      continue;
    }
    // 8. text
    if (data['text/plain'] !== undefined) {
      items.push({ kind: 'text', media_type: 'text/plain', text: mimeText(data['text/plain']) ?? '' });
      continue;
    }
    // 9. unsupported
    const firstMime = Object.keys(data)[0] ?? 'unknown';
    items.push({
      kind: 'unsupported',
      mime_type: firstMime,
      // "The value is still in the file" is the part the model needs: a bare
      // "unsupported output type" reads as "this output is empty", and a model that
      // believes an output is empty will happily rewrite the cell and destroy it
      // (review v8 V8-1). This tool never drops a stored output, so saying so is
      // simply true.
      message: `unsupported output type; the value is preserved in the file unchanged (mime: ${firstMime})`,
    });
  }

  return { items, extractedImages };
}

// ---------------------------------------------------------------------------

/**
 * The base64 payload of an image value, accepting the `data:` URL form.
 *
 * Only the exact shape `data:<anything>;base64,<payload>` is stripped, and only when
 * the payload actually follows; anything else is returned untouched so the normal
 * decode failure path still reports it.
 */
function stripDataUrlPrefix(value: string, mediaType: 'image/png' | 'image/jpeg'): string {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(value);
  if (match === null) {
    return value;
  }
  // The declared type is ignored rather than enforced: the mime KEY is what the
  // notebook says this data is, and a mismatch there is the file's problem, not a
  // reason to refuse to render an image the user can see.
  void mediaType;
  return match[2] ?? '';
}

function decodeBase64(base64: string): Uint8Array | null {
  const cleaned = canonicalBase64(base64);
  // Reject anything that is not base64 before handing it to the decoder, so the
  // failure can say WHICH way it is wrong. A bare "Invalid character" reaches the
  // model as a zero-byte image, which reads as "the image is empty" rather than
  // "this value is not base64" (review v8 V8-3).
  return cleaned === null ? null : decodeBase64ToBytes(cleaned);
}

/**
 * A base64 string in the one shape every reader accepts, or null.
 *
 * "Every reader" is the point: `atob` — and therefore the MCP SDK's
 * `ImageContent.data` validator — tolerates the base64 alphabet, `=` padding and
 * whitespace, but nothing else. A value that decodes through a laxer decoder and
 * then fails `atob` does not degrade, it kills the call, so canonicalizing is a
 * correctness step and not cosmetics (review v9 V9-1).
 */
export function canonicalBase64(value: string): string | null {
  const cleaned = value.replace(/\s+/g, '');
  return isBase64Shaped(cleaned) ? cleaned : null;
}

/**
 * The canonical base64 an image block may carry for a RAW document value, or null
 * when the value cannot produce one.
 *
 * The block-building paths used to read the document value again and hand it to
 * the SDK untested, so a `data:` URL was decodable for materialization and
 * simultaneously invalid as a block. Both paths now come through here, which is
 * what makes "decodes" and "can be returned" the same question again (SPEC §4.4).
 */
export function imageBlockBase64(value: string, mediaType: 'image/png' | 'image/jpeg'): string | null {
  const payload = stripDataUrlPrefix(value, mediaType);
  const cleaned = canonicalBase64(payload);
  // An empty payload is the one case a canonical form cannot express: `atob('')`
  // succeeds and yields zero bytes, which would serve a block that claims to be an
  // image and contains nothing. It takes the decode-failure route instead, where
  // the warning can say "empty" (review v8 V8-3's "empty vs broken" distinction).
  if (cleaned === null || cleaned === '') {
    return null;
  }
  return cleaned;
}

/**
 * Why an image value could not be materialized, in the model's words.
 *
 * The distinction that matters: "empty" and "broken" look identical in the response
 * (`bytes: 0`, `artifact_path: null`), so the reason has to be explicit or a model
 * will treat a malformed value as an absent one.
 */
function imageDecodeProblem(value: string): string {
  if (value.trim() === '') {
    return 'image value is empty';
  }
  if (/^data:/i.test(value.trim())) {
    return 'image value is a data: URL that could not be decoded (expected data:<mime>;base64,<payload>)';
  }
  return 'image value is not valid base64';
}

/**
 * Lower-bound byte estimate from the base64 text alone (no decode): 4 encoded
 * characters carry 3 bytes, minus padding. Deliberately conservative (never
 * over-estimates by more than the line breaks it ignores), so it can only
 * reject what the exact check would reject too.
 */
function approximateBase64Bytes(base64: string): number {
  let encoded = 0;
  let padding = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    // Skip ASCII whitespace, which base64 permits and Jupyter emits.
    if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
      continue;
    }
    encoded += 1;
    if (code === 0x3d /* '=' */) {
      padding += 1;
    }
  }
  return Math.floor((encoded * 3) / 4) - padding;
}

/** width/height priority: output metadata -> parsed image header -> null (SPEC §4.4). */
function imageSize(
  bytes: Uint8Array,
  mediaType: 'image/png' | 'image/jpeg',
  metadata: Record<string, unknown> | undefined,
): { width: number; height: number } | null {
  const metaSize = metadataSize(metadata, mediaType);
  if (metaSize !== null) {
    return metaSize;
  }
  return mediaType === 'image/png' ? parsePngSize(bytes) : parseJpegSize(bytes);
}

function metadataSize(
  metadata: Record<string, unknown> | undefined,
  mediaType: string,
): { width: number; height: number } | null {
  if (metadata === undefined) {
    return null;
  }
  const topLevel = pickSize(metadata);
  if (topLevel !== null) {
    return topLevel;
  }
  const nested = metadata[mediaType];
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return pickSize(nested as Record<string, unknown>);
  }
  return null;
}

function pickSize(record: Record<string, unknown>): { width: number; height: number } | null {
  const width = record['width'];
  const height = record['height'];
  if (typeof width === 'number' && Number.isInteger(width) && width >= 0 &&
      typeof height === 'number' && Number.isInteger(height) && height >= 0) {
        return { width, height };
  }
  return null;
}

function parsePngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8-byte signature, then chunk length (4) + "IHDR" (4), then BE width/height.
  if (bytes.length < 24) {
    return null;
  }
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width === null || height === null) {
    return null;
  }
  return { width, height };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function parseJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);
      if (width === null || height === null) {
        return null;
      }
      return { width, height };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const segmentLength = readUint16BE(bytes, offset + 2);
    if (segmentLength === null || segmentLength < 2) {
      return null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    return null;
  }
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

function readUint16BE(bytes: Uint8Array, offset: number): number | null {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) {
    return null;
  }
  return (b0 << 8) | b1;
}
