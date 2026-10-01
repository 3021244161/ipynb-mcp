// Tool result helpers: single text JSON block + optional image blocks (D24).
// IpynbError -> isError with {"code","message","detail"}; unexpected errors
// -> internal with stack on stderr only.

import { IpynbError, type JsonValue } from '../../core/errors.js';

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
export async function runTool(action: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await action();
  } catch (cause) {
    if (cause instanceof IpynbError) {
      return toolFailure(cause);
    }
    const detail: JsonValue = { stack: cause instanceof Error ? String(cause.stack ?? cause.message) : String(cause) };
    return toolFailure(new IpynbError('internal', 'unexpected internal failure', detail));
  }
}
