// Sidecar protocol types + NDJSON framing (SPEC §5.8).
// One chunk is NOT one line: bytes accumulate in a buffer and split on '\n';
// a single line above 64 MiB is a protocol error that kills the sidecar.

export interface SidecarRequest {
  readonly id: string;
  readonly op: string;
  readonly params: Record<string, unknown>;
}

export interface SidecarError {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}

export type SidecarResponse =
  | { readonly id: string; readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly id: string; readonly ok: false; readonly error: SidecarError };

export type SidecarMessage = SidecarResponse | SidecarEvent;

export interface SidecarEvent {
  readonly event: string;
  readonly kernelId?: string;
  readonly level?: string;
  readonly message?: string;
}

export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** Protocol-level framing failure; the caller must kill the sidecar and fail
 *  in-flight requests with kernel_died (SPEC §5.8). */
export class ProtocolFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolFramingError';
  }
}

export class NdjsonFramer {
  /**
   * Chunks of the UNTERMINATED remainder only, plus how many bytes they hold.
   * Accumulating into one growing buffer re-copied the whole line on every
   * chunk (`Buffer.concat`), so a single max-size line cost O(L^2/chunk) — a
   * 64 MiB line took ~9.4 s of main-thread CPU, which blocks the whole stdio
   * server (review v3 PERF-1). Chunks are only concatenated when a line is
   * actually emitted.
   */
  #chunks: Buffer[] = [];
  #pending = 0;

  /** Feed a chunk; returns all complete lines (without trailing newline). */
  push(chunk: Buffer): string[] {
    if (chunk.length === 0) {
      return [];
    }
    this.#chunks.push(chunk);
    this.#pending += chunk.length;
    const lines: string[] = [];
    try {
      for (;;) {
        const newlineIndex = this.#indexOfNewline();
        if (newlineIndex < 0) {
          break;
        }
        // Checked BEFORE copying: an over-long complete line must be rejected
        // without materialising it (SPEC §5.8).
        if (newlineIndex > MAX_LINE_BYTES) {
          throw new ProtocolFramingError(`sidecar line exceeds ${MAX_LINE_BYTES} bytes (protocol error)`);
        }
        const line = this.#take(newlineIndex);
        // Tolerate \r\n: strip a trailing CR.
        const text = line.toString('utf8');
        lines.push(text.endsWith('\r') ? text.slice(0, -1) : text);
      }
    } finally {
      if (this.#pending === 0) {
        // Free an empty chunk list even when the loop threw.
        this.#chunks = [];
      }
    }
    // Only the unterminated remainder counts toward the cap: it is the only
    // thing that can still grow into an over-long single line.
    if (this.#pending > MAX_LINE_BYTES) {
      throw new ProtocolFramingError(`sidecar line exceeds ${MAX_LINE_BYTES} bytes (protocol error)`);
    }
    return lines;
  }

  /** Offset of the first '\n' across the pending chunks, or -1. */
  #indexOfNewline(): number {
    if (this.#pending === 0) {
      return -1;
    }
    let offset = 0;
    for (const chunk of this.#chunks) {
      const found = chunk.indexOf(0x0a);
      if (found >= 0) {
        return offset + found;
      }
      offset += chunk.length;
    }
    return -1;
  }

  /** Copy `length` bytes off the front of the pending chunks (nearly always one). */
  #take(length: number): Buffer {
    if (this.#chunks.length === 1) {
      const only = this.#chunks[0]!;
      // subarray shares the chunk's memory, so a fast path that slices is
      // enough; the chunk stays referenced only for as long as `line` is.
      const line = only.subarray(0, length);
      const rest = only.subarray(length + 1);
      this.#chunks = rest.length === 0 ? [] : [rest];
      this.#pending = rest.length;
      return line;
    }
    const joined = Buffer.concat(this.#chunks, length + 1);
    const line = joined.subarray(0, length);
    const rest = joined.subarray(length + 1);
    this.#pending = rest.length;
    this.#chunks = rest.length === 0 ? [] : [rest];
    return line;
  }

  /** Current partial line length (diagnostics). */
  get pendingBytes(): number {
    return this.#pending;
  }
}

export function isSidecarResponse(message: SidecarMessage): message is SidecarResponse {
  return 'id' in message && typeof (message as SidecarResponse).id === 'string';
}

export function parseSidecarMessage(line: string): SidecarMessage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as SidecarMessage;
    }
    return null;
  } catch {
    return null;
  }
}
