// Tool result helpers: single text JSON block + optional image blocks (D24).
// IpynbError -> isError with {"code","message","detail"}; unexpected errors
// -> internal, with the stack kept OFF the model-visible payload.

import { IpynbError, createWarning, type JsonValue } from '../../core/errors.js';
import { isBase64Shaped } from '../../core/base64.js';
import type { Logger } from '../../log.js';

export type ImageBlock = { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' };

export interface ToolSuccess {
  readonly payload: JsonValue;
  readonly imageBlocks?: ReadonlyArray<{ data: string; media_type: 'image/png' | 'image/jpeg' }>;
}

export type ToolOutcome = ToolSuccess | ToolFailure;

export interface ToolFailure {
  readonly error: IpynbError;
}

export function toolFailure(error: IpynbError): ToolFailure {
  return { error };
}

export function toCallToolResult(outcome: ToolOutcome): {
  content: Array<{ type: 'text'; text: string } | ImageBlock>;
  isError?: boolean;
} {
  if ('error' in outcome) {
    const error = outcome.error;
    const body = JSON.stringify({ code: error.code, message: error.message, detail: error.detail ?? null });
    return { content: [{ type: 'text', text: body }], isError: true };
  }
  const text = JSON.stringify(outcome.payload);
  const content: Array<{ type: 'text'; text: string } | ImageBlock> = [{ type: 'text', text }];
  let droppedBlocks = 0;
  for (const block of outcome.imageBlocks ?? []) {
    // The SDK validates `ImageContent.data` with `atob` and a rejection is a
    // PROTOCOL error for the entire result: one malformed value costs the model the
    // whole notebook (review v9 V9-1/V9-3). A per-block check here turns that into
    // the documented degradation — the block is withheld and the payload says so —
    // which is the boundary §4.4 draws between "cannot materialize this image" and
    // "cannot answer this call".
    //
    // It is a backstop, not the fix: producers canonicalize their payload (see
    // `imageBlockBase64`), so this only fires for a future path that forgets to.
    if (!isBase64Shaped(block.data) || block.data === '') {
      droppedBlocks += 1;
      continue;
    }
    content.push({ type: 'image', data: block.data, mimeType: block.media_type });
  }
  if (droppedBlocks > 0) {
    const rewritten = appendBlockWarning(text, droppedBlocks);
    if (rewritten !== null) {
      content[0] = { type: 'text', text: rewritten };
    }
  }
  return { content };
}

/**
 * Append the block-legality warning to a payload that was already serialized.
 *
 * Re-serializing is deliberate: the payload was stringified once for the happy
 * path, and threading a mutable copy through every tool to avoid a second pass
 * would be a larger change than this backstop is worth. The rewrite is a parse +
 * one key append, and it fails soft (null = keep the original text) so a payload
 * this function misreads can never cost the model its answer.
 */
function appendBlockWarning(serialized: string, droppedBlocks: number): string | null {
  const warning = createWarning(
    'image_materialize_failed',
    `${String(droppedBlocks)} image block(s) had no returnable base64 payload and were withheld; artifact_path and image_index may be stale for them`,
  );
  // Copied field by field: `Warning`'s members are `readonly`, which is not
  // assignable to `JsonValue`'s index signature, and the copy is what goes back out
  // through `JSON.stringify` anyway.
  const entry: JsonValue = { code: warning.code, message: warning.message };
  try {
    const payload: unknown = JSON.parse(serialized);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, JsonValue>;
    const existing = record['warnings'];
    record['warnings'] = [...(Array.isArray(existing) ? existing : []), entry];
    return JSON.stringify(record);
  } catch {
    // Unreachable for a payload we just stringified. Falling back to the original
    // text is strictly better than trading the model's answer for an image notice.
    return null;
  }
}

/** Wrap a handler so every throw becomes a structured tool failure. */
export async function runTool(
  action: () => Promise<ToolOutcome>,
  logger?: Logger,
): Promise<ToolOutcome> {
  try {
    return await action();
  } catch (cause) {
    if (cause instanceof IpynbError) {
      return toolFailure(cause);
    }
    // The stack carries server-side source lines and absolute paths, and
    // `detail` is model-visible: send the stack to the log, a name+message to
    // the model (review v3 SEC-2).
    const stack = cause instanceof Error ? String(cause.stack ?? cause.message) : String(cause);
    logger?.warn(`unexpected internal failure: ${stack}`);
    const detail: JsonValue = {
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    };
    return toolFailure(new IpynbError('internal', 'unexpected internal failure', detail));
  }
}
