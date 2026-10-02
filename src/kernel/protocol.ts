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
  #buffer: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns all complete lines (without trailing newline). */
  push(chunk: Buffer): string[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const lines: string[] = [];
    let newlineIndex = this.#buffer.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = this.#buffer.subarray(0, newlineIndex);
      if (line.length > MAX_LINE_BYTES) {
        // SPEC §5.8 caps a SINGLE line: check complete lines here so a chunk
        // holding many small lines never trips the cap (review A21).
        throw new ProtocolFramingError(
          `sidecar line exceeds ${MAX_LINE_BYTES} bytes (protocol error)`,
        );
      }
      this.#buffer = this.#buffer.subarray(newlineIndex + 1);
      // Tolerate \r\n: strip a trailing CR.
      const text = line.toString('utf8');
      lines.push(text.endsWith('\r') ? text.slice(0, -1) : text);
      newlineIndex = this.#buffer.indexOf(0x0a);
    }
    // Only the unterminated remainder counts toward the cap: it is the only
    // thing that can still grow into an over-long single line.
    if (this.#buffer.length > MAX_LINE_BYTES) {
      throw new ProtocolFramingError(
        `sidecar line exceeds ${MAX_LINE_BYTES} bytes (protocol error)`,
      );
    }
    return lines;
  }

  /** Current partial line length (diagnostics). */
  get pendingBytes(): number {
    return this.#buffer.length;
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
