// Output mapping (SPEC §5.4): raw kernel outputs -> model-friendly OutputItems.
// Order of checks is fixed and first-match-wins; every raw output yields
// exactly 0 or 1 items. Pure logic — base64 decoding uses the global atob,
// image headers are parsed by hand (no image libraries, SPEC §4.4).

import type { JsonValue } from './errors.js';
import type { Hasher, NotebookCell } from './parse.js';

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
      // Unknown output kinds are not this layer's business: nbformat has no
      // catch-all shape to project, so they are dropped like any other
      // unparseable entry rather than invented into display_data.
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
    // 3./4. images (png first, then jpeg)
    const imageMediaType =
      data['image/png'] !== undefined ? 'image/png' : data['image/jpeg'] !== undefined ? 'image/jpeg' : null;
    if (imageMediaType !== null) {
      const base64 = data[imageMediaType] ?? '';
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
