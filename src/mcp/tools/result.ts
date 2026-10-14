// Tool result helpers: single text JSON block + optional image blocks (D24).
// IpynbError -> isError with {"code","message","detail"}; unexpected errors
// -> internal, with the stack kept OFF the model-visible payload.

import { IpynbError, createWarning, type JsonValue } from '../../core/errors.js';
import { isBase64Shaped } from '../../core/base64.js';
import { enforceResponseBudget } from '../../core/response-budget.js';
import { reconcileTruncationFlags } from '../render/read.js';
import { materializeImageArtifact, type ImageArtifactPlan } from '../../fs/artifact.js';
import type { Logger } from '../../log.js';

export type ImageBlock = { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' };

export interface ToolSuccess {
  readonly payload: JsonValue;
  readonly imageBlocks?: ReadonlyArray<{ data: string; media_type: 'image/png' | 'image/jpeg' }>;
  readonly imageArtifacts?: readonly ImageArtifactPlan[];
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
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
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
      Math.max(128, budget - 512),
    );
    const reconciled = reconcileTruncationFlags(fitted.payload, fitted.truncatedFields);
    return { content: [{ type: 'text', text: JSON.stringify(reconcileImageReferences(reconciled, new Map())) }], isError: true };
  }

  // THE WHOLE FRAME HAS A CEILING, and this is where it is enforced. A frame over the SDK reader's
  // 10 MiB is not a big response — the reader throws, the client's connection closes with
  // `McpError -32000`, and every later call in that session answers "Not connected". Nothing bounded a
  // response before this: `inline_text_chars` only reached `stream` items, so a large `text/plain`,
  // `html` or `json` output, or a large image, went through untouched (review v13 V13-1; measured with
  // a real client at 9.9 MiB pass / 10.2 MiB session death, and 60 small items totalling 17.6 MiB also
  // fatal — the cliff is on the FRAME, not on any single item).
  const images = outcome.imageBlocks ?? [];
  const frameBudget = Math.max(128, budget - 512);

  // Images are counted first because their degradation is the documented one: the payload already
  // carries `artifact_path` and `image_index`, so withholding a block costs a second call rather than
  // the data. Text has no such fallback, so it gets whatever is left after the image total.
  // Base64 is ASCII, so its UTF-16 length and its byte length agree; the 128 covers the JSON envelope
  // around the block (`{"type":"image","data":"…","mimeType":"image/png"}`).
  const imageBytes = images.reduce((total, block) => total + block.data.length + 128, 0);
  const fitted = enforceResponseBudget(outcome.payload, Math.min(frameBudget, Math.max(MIN_TEXT_BUDGET, frameBudget - imageBytes)));
  // STRUCTURED FLAGS MUST AGREE WITH WHAT IS DELIVERED, and the budget cannot enforce that: it edits JSON and
  // knows nothing about what a field means, while `source_truncated` is a boolean the model reads to decide
  // whether the source it holds is the whole source. Measured before this line existed: a 12 MiB source
  // arrived shortened, with a marker and a warning, while the payload still said
  // `source_truncated: false` — the structural field contradicting the value beside it (review v16 V16-1).
  // The budget reports which fields it cut; the render layer, which owns the semantics, sets its own flags.
  const reconciled = reconcileTruncationFlags(fitted.payload, fitted.truncatedFields);
  let text = JSON.stringify(reconciled);

  const content: Array<{ type: 'text'; text: string } | ImageBlock> = [{ type: 'text', text }];
  let droppedBlocks = 0;
  let invalidBlocks = 0;
  let overBudgetBlocks = 0;
  const returnedIndexes = new Map<number, number>();
  // What the text frame left for image blocks. If the payload alone exceeded the budget, this is small
  // or negative and the blocks are withheld — which is the intended order: the model keeps the
  // answer's substance (what ran, what it wrote) plus the paths to the images.
  let remaining = frameBudget - Buffer.byteLength(JSON.stringify(text), 'utf8');
  for (const [index, block] of images.entries()) {
    // The SDK validates `ImageContent.data` with `atob` and a rejection is a
    // PROTOCOL error for the entire result: one malformed value costs the model the
    // whole notebook (review v9 V9-1/V9-3). A per-block check here turns that into
    // the documented degradation — the block is withheld and the payload says so —
    // which is the boundary §4.4 draws between "cannot materialize this image" and
    // "cannot answer this call".
    //
    // It is a backstop, not the fix: producers canonicalize their payload (see
    // `imageBlockBase64`), so this only fires for a future path that forgets to.
    const fits = block.data.length + 128 <= remaining;
    const valid = isBase64Shaped(block.data) && block.data !== '';
    if (!valid || !fits) {
      droppedBlocks += 1;
      if (valid) {
        overBudgetBlocks += 1;
      } else {
        invalidBlocks += 1;
      }
      continue;
    }
    remaining -= block.data.length + 128;
    returnedIndexes.set(index, content.length - 1);
    content.push({ type: 'image', data: block.data, mimeType: block.media_type });
  }
  const imageReconciled = reconcileImageReferences(reconciled, returnedIndexes);
  if (imageReconciled !== reconciled) {
    text = JSON.stringify(imageReconciled);
    content[0] = { type: 'text', text };
  }
  if (droppedBlocks > 0) {
    const rewritten = appendBlockWarning(text, invalidBlocks, overBudgetBlocks);
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
function appendBlockWarning(serialized: string, invalidBlocks: number, overBudgetBlocks: number): string | null {
  const additions = [];
  if (invalidBlocks > 0) {
    additions.push(createWarning('image_materialize_failed', `${invalidBlocks} image block(s) had no returnable base64 payload; their artifact_path and image_index are null`));
  }
  if (overBudgetBlocks > 0) {
    additions.push(createWarning('output_truncated', `${overBudgetBlocks} image block(s) did not fit the response budget; their artifact_path and image_index are null`));
  }
  try {
    const payload: unknown = JSON.parse(serialized);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, JsonValue>;
    const existing = record['warnings'];
    const warnings = Array.isArray(existing) ? [...existing] : [];
    for (const addition of additions) {
      const match = warnings.findIndex((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && entry['code'] === addition.code);
      const previous = warnings[match];
      if (typeof previous === 'object' && previous !== null && !Array.isArray(previous) && typeof previous['message'] === 'string') {
        warnings[match] = { ...previous, message: `${previous['message']}; ${addition.message}` };
      } else {
        warnings.push({ code: addition.code, message: addition.message });
      }
    }
    record['warnings'] = warnings;
    return JSON.stringify(record);
  } catch {
    // Unreachable for a payload we just stringified. Falling back to the original
    // text is strictly better than trading the model's answer for an image notice.
    return null;
  }
}

/** Finalize only the image blocks the budget will deliver (SPEC §4.3/U26). */
export async function finalizeToolResult(outcome: ToolOutcome, options?: ToCallToolResultOptions): Promise<ReturnType<typeof toCallToolResult>> {
  if ('error' in outcome || (outcome.imageArtifacts?.length ?? 0) === 0) {
    return toCallToolResult(outcome, options);
  }
  // Artifact failures add a bounded notice after fitting; reserve that space
  // before writing so no later budget pass has to withdraw an already-written image.
  const budget = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const result = toCallToolResult(outcome, { ...options, maxResponseBytes: budget - 4096 });
  const textBlock = result.content[0];
  if (textBlock?.type !== 'text') {
    return result;
  }
  const candidates = result.content.filter((block): block is ImageBlock => block.type === 'image');
  const planByIndex = new Map(outcome.imageArtifacts?.map((plan) => [plan.imageIndex, plan]));
  const original = outcome.imageBlocks ?? [];
  const images: ImageBlock[] = [];
  const indexes = new Map<number, number>();
  let candidateIndex = 0;
  let failures = 0;
  let cancelled = options?.signal?.aborted === true;
  for (const [originalIndex, block] of original.entries()) {
    if (options?.signal?.aborted) {
      cancelled = true;
      break;
    }
    const candidate = candidates[candidateIndex];
    if (candidate === undefined || candidate.data !== block.data || candidate.mimeType !== block.media_type) {
      continue;
    }
    const plan = planByIndex.get(originalIndex);
    const failure = plan === undefined ? null : await materializeImageArtifact(plan);
    if (failure === null) {
      indexes.set(candidateIndex, images.length);
      images.push(candidate);
    } else {
      failures += 1;
      options?.logger?.warn(failure.message);
    }
    candidateIndex += 1;
  }
  const payload = reconcileImageReferences(JSON.parse(textBlock.text) as JsonValue, indexes);
  if (failures > 0 && typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, JsonValue>;
    const warnings = record['warnings'];
    const warning = createWarning('image_materialize_failed', `${failures} image artifact(s) could not be written; those image blocks were omitted`);
    record['warnings'] = [...(Array.isArray(warnings) ? warnings : []), { code: warning.code, message: warning.message }];
  }
  cancelled ||= options?.signal?.aborted === true;
  if (cancelled) {
    const fitted = enforceResponseBudget({
      code: 'cancelled', message: 'response cancelled during image materialization', detail: payload,
    }, Math.max(128, budget - images.reduce((total, image) => total + image.data.length + 128, 0) - 512));
    const reconciled = reconcileTruncationFlags(fitted.payload, fitted.truncatedFields);
    const indexed = reconcileImageReferences(reconciled, new Map(images.map((_, index) => [index, index])));
    return { content: [{ type: 'text', text: JSON.stringify(indexed) }, ...images], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }, ...images] };
}

function reconcileImageReferences(payload: JsonValue, indexes: ReadonlyMap<number, number>): JsonValue {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return payload;
  }
  let record = payload as Record<string, JsonValue>;
  const rewriteCell = (entry: JsonValue): JsonValue => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return entry;
    }
    let cell = entry as Record<string, JsonValue>;
    for (const key of ['outputs', 'outputs_summary']) {
      const items = cell[key];
      if (!Array.isArray(items)) {
        continue;
      }
      let changed = false;
      const rewritten = items.map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item) || item['kind'] !== 'image') {
          return item;
        }
        const oldIndex = item['image_index'];
        const index = typeof oldIndex === 'number' ? indexes.get(oldIndex) ?? null : null;
        const artifactPath = index === null ? null : item['artifact_path'];
        if (oldIndex === index && item['artifact_path'] === artifactPath) {
          return item;
        }
        changed = true;
        return { ...item, image_index: index, artifact_path: artifactPath ?? null };
      });
      if (changed) {
        cell = { ...cell, [key]: rewritten };
      }
    }
    return cell;
  };
  for (const key of ['cells', 'executed']) {
    const cells = record[key];
    if (Array.isArray(cells)) {
      const rewritten = cells.map(rewriteCell);
      if (rewritten.some((entry, index) => entry !== cells[index])) {
        record = { ...record, [key]: rewritten };
      }
    }
  }
  const detail = record['detail'];
  if (detail !== undefined) {
    const rewritten = reconcileImageReferences(detail, indexes);
    if (rewritten !== detail) {
      record = { ...record, detail: rewritten };
    }
  }
  return record;
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
