// Tool result helpers: single text JSON block + optional image blocks (D24).
// IpynbError -> isError with {"code","message","detail"}; unexpected errors
// -> internal, with the stack kept OFF the model-visible payload.

import { IpynbError, type JsonValue } from '../../core/errors.js';
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
  for (const block of outcome.imageBlocks ?? []) {
    content.push({ type: 'image', data: block.data, mimeType: block.media_type });
  }
  return { content };
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
