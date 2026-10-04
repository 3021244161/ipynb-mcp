// Sidecar protocol types + NDJSON framing (SPEC §5.8).
// One chunk is NOT one line: bytes accumulate in a buffer and split on '\n';
// a single line above 64 MiB is a protocol error that kills the sidecar.

import { parseJsonExact } from '../core/json-exact.js';

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

/** Initial capacity of the partial-line buffer (one typical kernel message). */
const INITIAL_STAGING_BYTES = 64 * 1024;

export class NdjsonFramer {
  /**
   * The UNTERMINATED remainder, in ONE buffer that grows by doubling.
   *
   * Two earlier designs were both O(L^2) for a max-size line arriving in small
   * chunks, and the review measured both. v3 kept a list of chunks and only
   * concatenated when a line was emitted: that fixed the copy but left the SCAN
   * re-reading the whole newline-free prefix on every push. v4 added a cursor,
   * which exposed the last two quadratic terms — the per-push walk over the
   * chunk list (34 million chunk visits for 64 MiB in 16 KiB chunks) and the
   * `Buffer.concat` of a growing prefix (8.6 GB copied for the same input).
   * A doubling buffer makes both amortised O(L): each byte is copied at most
   * twice over the line's whole life, and never scanned twice.
   *
   * The invariant that keeps this simple: `#staging` NEVER contains a newline,
   * so every complete line either lies inside the incoming chunk or straddles
   * the boundary between the two. Nothing is ever moved backwards.
   */
  #staging: Buffer = Buffer.alloc(0);
  /**
   * Valid bytes at the front of `#staging`. The buffer is REUSED across lines
   * (its capacity only ever grows) because a fresh allocation per line costs more
   * than the copies it avoids: the first draft of this design allocated one
   * buffer per line and was measurably slower than the implementation it
   * replaced, which is why the length is tracked separately from the capacity.
   */
  #stagingLength = 0;

  /** Current partial line length (diagnostics). */
  get pendingBytes(): number {
    return this.#stagingLength;
  }

  /** Feed a chunk; returns all complete lines (without trailing newline). */
  push(chunk: Buffer): string[] {
    if (chunk.length === 0) {
      return [];
    }
    const lines: string[] = [];
    let consumed = 0;
    /** Bytes of the CURRENT line held in the staging buffer. */
    let pending = this.#stagingLength;
    let newlineIndex = chunk.indexOf(0x0a);
    while (newlineIndex >= 0) {
      // Checked BEFORE copying: an over-long complete line must be rejected
      // without materialising it (SPEC §5.8).
      if (pending + (newlineIndex - consumed) > MAX_LINE_BYTES) {
        this.#discard();
        throw new ProtocolFramingError(`sidecar line exceeds ${MAX_LINE_BYTES} bytes (protocol error)`);
      }
      lines.push(decodeLine(this.#lineWith(chunk.subarray(consumed, newlineIndex), pending)));
      // That line is complete. The loop continues INSIDE the same chunk, where
      // every following line starts at a chunk boundary, so nothing is pending
      // for them. Leaving the first line's bytes counted charged them to every
      // later line too and rejected a chunk of many small lines (review A21).
      pending = 0;
      consumed = newlineIndex + 1;
      newlineIndex = chunk.indexOf(0x0a, consumed);
    }
    const tail = chunk.subarray(consumed);
    if (tail.length === 0) {
      // The chunk ended exactly on a newline, or held no newline and no bytes.
      if (pending === 0) {
        this.#staging = Buffer.alloc(0);
      }
    } else if (pending === 0) {
      // Nothing pending, so the tail IS the current line and there is nothing to
      // copy: adopt the caller chunk. Nothing mutates it, and a tail longer than
      // the cap is caught below rather than copied first.
      this.#staging = tail;
      pending = tail.length;
    } else {
      this.#appendToStaging(tail, pending);
      pending += tail.length;
    }
    this.#stagingLength = pending;
    // Only the unterminated remainder counts toward the cap: it is the only
    // thing that can still grow into an over-long single line (a chunk holding
    // many complete small lines legitimately exceeds it, review A21).
    if (pending > MAX_LINE_BYTES) {
      // Reset before throwing (review v5 FRAME-3): leaving the rejected bytes in
      // the staging buffer made `pendingBytes` lie and made every later push
      // throw again, so the object was quietly single-use. The transport kills
      // the sidecar on a protocol error, but a wedged framer is a trap for
      // whoever instantiates the next one.
      this.#discard();
      throw new ProtocolFramingError(`sidecar line exceeds ${MAX_LINE_BYTES} bytes (protocol error)`);
    }
    return lines;
  }

  /** Return to the initial state; used by the protocol-error paths (FRAME-3). */
  #discard(): void {
    this.#staging = Buffer.alloc(0);
    this.#stagingLength = 0;
  }

  /** The staging bytes + segment, without copying when either side is empty. */
  #lineWith(segment: Buffer, pending: number): Buffer {
    if (pending === 0) {
      return segment;
    }
    const held = this.#staging.subarray(0, pending);
    if (segment.length === 0) {
      return held;
    }
    return Buffer.concat([held, segment]);
  }

  /** Grow by doubling so each byte is copied a bounded number of times. */
  #appendToStaging(tail: Buffer, pending: number): void {
    const needed = pending + tail.length;
    if (needed > this.#staging.length) {
      let capacity = Math.max(INITIAL_STAGING_BYTES, this.#staging.length);
      const cap = MAX_LINE_BYTES + 1;
      while (capacity < needed) {
        capacity = Math.min(cap, capacity * 2);
      }
      const next = Buffer.allocUnsafe(capacity);
      this.#staging.subarray(0, pending).copy(next, 0);
      this.#staging = next;
    }
    tail.copy(this.#staging, pending);
  }
}

/** Strip a trailing CR so CRLF framing is tolerated (SPEC §5.8). */
function decodeLine(line: Buffer): string {
  const text = line.toString('utf8');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

export function isSidecarResponse(message: SidecarMessage): message is SidecarResponse {
  return 'id' in message && typeof (message as SidecarResponse).id === 'string';
}

export function parseSidecarMessage(line: string): SidecarMessage | null {
  try {
    // The exact parser, not `JSON.parse`: the sidecar's `json.dumps` writes a Python
    // int of any size correctly (`2**64` is 20 digits on the wire), and `JSON.parse`
    // would round it here — before the value is ever stored, so the file would get
    // the rounded number and nothing upstream could tell (review v9 V9-5).
    const parsed: unknown = parseJsonExact(line);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as SidecarMessage;
    }
    return null;
  } catch {
    return null;
  }
}
