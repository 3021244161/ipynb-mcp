// Tool result helpers: single text JSON block + optional image blocks (D24).
// IpynbError -> isError with {"code","message","detail"}; unexpected errors
// -> internal, with the stack kept OFF the model-visible payload.

import { IpynbError, createWarning, type JsonValue } from '../../core/errors.js';
import { isBase64Shaped } from '../../core/base64.js';
import { enforceResponseBudget } from '../../core/response-budget.js';
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

/**
 * Budget for one tool response when the caller does not pass the configured one.
 *
 * Matches `--max-response-bytes`' default. It lives here as well because `toCallToolResult` is also
 * called from tests and helpers that have no config, and a missing budget must never mean "no budget"
 * — that is the state this whole mechanism exists to end.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * The floor under the text budget, so image blocks can never squeeze the payload to nothing.
 *
 * A tool response whose JSON says nothing is not a smaller answer, it is a broken one: the model needs
 * the `path`, the cell indexes and the warnings to act at all. 64 KiB is enough for a summary-shaped
 * payload with room to spare.
 */
const MIN_TEXT_BUDGET = 64 * 1024;

export function toolFailure(error: IpynbError): ToolFailure {
  return { error };
}

export interface ToCallToolResultOptions {
  /** The configured response budget in bytes; see `--max-response-bytes`. */
  readonly maxResponseBytes?: number;
}

export function toCallToolResult(
  outcome: ToolOutcome,
  options?: ToCallToolResultOptions,
): {
  content: Array<{ type: 'text'; text: string } | ImageBlock>;
  isError?: boolean;
} {
  const budget = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  if ('error' in outcome) {
    const error = outcome.error;
    // AN ERROR RESPONSE IS A RESPONSE, and it needs the same budget. `detail.executed[]` carries the outputs
    // of every cell that completed, so a run that produced a large output and then failed — timeout,
    // cancel, or a dead kernel — sent an unbounded frame; the client's connection died, and the model
    // learned neither the failure nor which cells had run, while the file had ALREADY been written back.
    // That is the worst version of the shape this budget exists for (review v14 V14-12). The first version
    // applied it on the success path only, so the failure paths were exactly the ones that still broke.
    const fitted = enforceResponseBudget(
      { code: error.code, message: error.message, detail: error.detail ?? null } as JsonValue,
      budget,
    );
    return { content: [{ type: 'text', text: JSON.stringify(fitted.payload) }], isError: true };
  }

  // THE WHOLE FRAME HAS A CEILING, and this is where it is enforced. A frame over the SDK reader's
  // 10 MiB is not a big response — the reader throws, the client's connection closes with
  // `McpError -32000`, and every later call in that session answers "Not connected". Nothing bounded a
  // response before this: `inline_text_chars` only reached `stream` items, so a large `text/plain`,
  // `html` or `json` output, or a large image, went through untouched (review v13 V13-1; measured with
  // a real client at 9.9 MiB pass / 10.2 MiB session death, and 60 small items totalling 17.6 MiB also
  // fatal — the cliff is on the FRAME, not on any single item).
  const images = outcome.imageBlocks ?? [];

  // Images are counted first because their degradation is the documented one: the payload already
  // carries `artifact_path` and `image_index`, so withholding a block costs a second call rather than
  // the data. Text has no such fallback, so it gets whatever is left after the image total.
  // Base64 is ASCII, so its UTF-16 length and its byte length agree; the 128 covers the JSON envelope
  // around the block (`{"type":"image","data":"…","mimeType":"image/png"}`).
  const imageBytes = images.reduce((total, block) => total + block.data.length + 128, 0);
  const fitted = enforceResponseBudget(outcome.payload, Math.max(MIN_TEXT_BUDGET, budget - imageBytes));
  let text = JSON.stringify(fitted.payload);

  const content: Array<{ type: 'text'; text: string } | ImageBlock> = [{ type: 'text', text }];
  let droppedBlocks = 0;
  // What the text frame left for image blocks. If the payload alone exceeded the budget, this is small
  // or negative and the blocks are withheld — which is the intended order: the model keeps the
  // answer's substance (what ran, what it wrote) plus the paths to the images.
  let remaining = budget - Buffer.byteLength(text, 'utf8');
  for (const block of images) {
    // The SDK validates `ImageContent.data` with `atob` and a rejection is a
    // PROTOCOL error for the entire result: one malformed value costs the model the
    // whole notebook (review v9 V9-1/V9-3). A per-block check here turns that into
    // the documented degradation — the block is withheld and the payload says so —
    // which is the boundary §4.4 draws between "cannot materialize this image" and
    // "cannot answer this call".
    //
    // It is a backstop, not the fix: producers canonicalize their payload (see
    // `imageBlockBase64`), so this only fires for a future path that forgets to.
    const fits = block.data.length <= remaining;
    if (!isBase64Shaped(block.data) || block.data === '' || !fits) {
      droppedBlocks += 1;
      continue;
    }
    remaining -= block.data.length;
    content.push({ type: 'image', data: block.data, mimeType: block.media_type });
  }
  if (droppedBlocks > 0) {
    const rewritten = appendBlockWarning(text, droppedBlocks);
    if (rewritten !== null) {
      text = rewritten;
      content[0] = { type: 'text', text };
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
    `${String(droppedBlocks)} image block(s) were withheld: no returnable base64 payload, or the response budget did not fit them. artifact_path and image_index are still authoritative`,
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
