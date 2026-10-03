// Output mapping (SPEC §5.4): raw kernel outputs -> model-friendly OutputItems.
// Order of checks is fixed and first-match-wins; every raw output yields
// exactly 0 or 1 items. Pure logic — base64 decoding uses the global atob,
// image headers are parsed by hand (no image libraries, SPEC §4.4).

import type { JsonValue } from './errors.js';
// Value types are imported, not redefined: the execution path and the write gate
// must answer "is this representable?" identically (review v6 GATE-5).
import { isJsonMime, isRepresentableMimeValue, type Hasher, type NotebookCell } from './parse.js';

/** Raw output as delivered by the sidecar protocol (SPEC §5.8, + metadata for §4.4). */
export interface RawOutput {
  outputType: 'stream' | 'display_data' | 'execute_result' | 'error';
  data?: Record<string, string>;
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
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const text = dataValueToString(value);
        if (text !== null) {
          normalized[key] = text;
        }
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

export type OutputItem =
  | { kind: 'stream'; stream_name: 'stdout' | 'stderr'; text: string; truncated: boolean; truncated_at_chars: number | null }
  | { kind: 'text'; media_type: 'text/plain'; text: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'html'; html: string; text_fallback: string }
  | { kind: 'json'; value: JsonValue }
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
    // The value must be NARROWED to a string before it is treated as base64. The
    // kernel can send any JSON value for a mime key, and a raw `display({'image/png':
    // 123})` used to reach `base64.replace`, throw a TypeError and abort the whole
    // run with `internal` — a code SPEC §4.8 does not list for notebook_run, from a
    // path a user's own cell can trigger. `?? ''` only caught null/undefined
    // (review v6 CRASH-1). A non-string value takes the existing
    // image_materialize_failed route, which is the documented exit for an image
    // that cannot be materialized (SPEC §4.4).
    const imageValue = (key: string): string | null => {
      const value = data[key];
      return typeof value === 'string' ? value : null;
    };
    const imageMediaType =
      data['image/png'] !== undefined ? 'image/png' : data['image/jpeg'] !== undefined ? 'image/jpeg' : null;
    if (imageMediaType !== null) {
      const rawImage = imageValue(imageMediaType);
      if (rawImage === null) {
        items.push({
          kind: 'image',
          media_type: imageMediaType,
          width: null,
          height: null,
          bytes: 0,
          artifact_path: null,
          image_index: null,
          text_fallback: typeof data['text/plain'] === 'string' ? data['text/plain'] : '',
        });
        // Register the failure so the caller emits the documented
        // `image_materialize_failed` warning. Without this entry the output would
        // be silently "an image with no artifact", which is the kind of quiet
        // degradation this project exists to avoid.
        extractedImages.push({
          outputIndex: items.length - 1,
          mediaType: imageMediaType,
          bytes: new Uint8Array(0),
          width: null,
          height: null,
          sha256Hex: options.hasher.sha256Hex(String(rawImage ?? '')),
          decodeFailed: true,
        });
        continue;
      }
      const base64 = rawImage;
      // Cheap pre-check on the ENCODED length before decoding: base64 is 4/3 of
      // the payload, so an obviously oversized image never needs the decode
      // (which itself costs ~2.5x the image in transient copies) nor the
      // SHA-256 pass. Behaviour is unchanged — the check below still reports
      // the exact byte count for anything that gets decoded (review v3 PERF-2).
      const approxBytes = approximateBase64Bytes(base64);
      if (approxBytes > options.maxImageBytes) {
        items.push({
          kind: 'unsupported',
          mime_type: imageMediaType,
          message: `image exceeds max_image_bytes (>= ${approxBytes} > ${options.maxImageBytes})`,
        });
        continue;
      }
      const decoded = decodeBase64(base64);
      if (decoded !== null && decoded.byteLength > options.maxImageBytes) {
        // Oversized images become unsupported and never materialize (SPEC §4.4).
        items.push({
          kind: 'unsupported',
          mime_type: imageMediaType,
          message: `image exceeds max_image_bytes (${decoded.byteLength} > ${options.maxImageBytes})`,
        });
        continue;
      }
      const fallback = data['text/plain'] ?? '';
      if (decoded === null) {
        // Decoding failed: stays kind:"image" with nulls; caller warns
        // image_materialize_failed (SPEC §4.4).
        items.push({
          kind: 'image',
          media_type: imageMediaType,
          width: null,
          height: null,
          bytes: 0,
          artifact_path: null,
          image_index: null,
          text_fallback: fallback,
        });
        extractedImages.push({
          outputIndex: items.length - 1,
          mediaType: imageMediaType,
          bytes: new Uint8Array(0),
          width: null,
          height: null,
          sha256Hex: options.hasher.sha256Hex(base64),
          decodeFailed: true,
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
      });
      continue;
    }
    // 5. markdown
    if (data['text/markdown'] !== undefined) {
      items.push({ kind: 'markdown', text: data['text/markdown'] ?? '' });
      continue;
    }
    // 6. html
    if (data['text/html'] !== undefined) {
      items.push({ kind: 'html', html: data['text/html'] ?? '', text_fallback: data['text/plain'] ?? '' });
      continue;
    }
    // 7. json (parse failure degrades to text, SPEC §5.4 row 7)
    if (data['application/json'] !== undefined) {
      const rawJson = data['application/json'] ?? '';
      try {
        const value = JSON.parse(rawJson) as JsonValue;
        items.push({ kind: 'json', value });
      } catch {
        items.push({ kind: 'text', media_type: 'text/plain', text: rawJson });
      }
      continue;
    }
    // 8. text
    if (data['text/plain'] !== undefined) {
      items.push({ kind: 'text', media_type: 'text/plain', text: data['text/plain'] ?? '' });
      continue;
    }
    // 9. unsupported
    const firstMime = Object.keys(data)[0] ?? 'unknown';
    items.push({ kind: 'unsupported', mime_type: firstMime, message: 'unsupported output type' });
  }

  return { items, extractedImages };
}

// ---------------------------------------------------------------------------

function decodeBase64(base64: string): Uint8Array | null {
  const cleaned = base64.replace(/\s+/g, '');
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
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
