// The whole-response budget (review v13 V13-1).
//
// WHY THIS EXISTS. Every tool result travels to the client as ONE newline-delimited JSON-RPC frame,
// and the MCP SDK's `ReadBuffer` rejects a frame larger than `STDIO_DEFAULT_MAX_BUFFER_SIZE`
// (10 MiB) by throwing — the client's connection dies with `McpError -32000: Connection closed` and
// every later call answers "Not connected". Nothing in this server bounded a response: the only
// limit was `inline_text_chars`, and it applied to `stream` items ONLY, so a `text/plain`,
// `text/html`, `application/json` or image output of any size went straight through. Measured with a
// real SDK client: 9.9 MiB succeeded silently, 10.2 MiB killed the session, and 60 small items
// totalling 17.6 MiB killed it too — the cliff is on the FRAME, not on any one item.
//
// The worst version of that is a `notebook_run`: the server writes the outputs to the user's file
// successfully, then the model never learns the run happened, because the response carrying the news
// was too big to deliver.
//
// So this module enforces a byte budget on the serialized frame, BEFORE it is sent, by degrading the
// payload rather than truncating the JSON (which would hand the model a parse error). Everything it
// removes is reported: the SPEC §5.4 rule is that truncation is never silent, and the mechanism for
// that already existed as `truncated` / `truncated_at_chars` on output items plus the
// `output_truncated` warning code — this extends their reach from "stream items over
// inline_text_chars" to "any item over what the transport can carry".
//
// A DEVIATION, recorded as D-065: SPEC §5.4 and §7 describe truncation only for stream thresholds and
// say nothing about a total response size, because the 10 MiB ceiling lives in the transport (the
// SDK), not in the format. Per AGENTS §0 the deviation is registered rather than resolved by editing
// the SPEC.

import { createWarning, type JsonValue } from './errors.js';

/** The warning every degradation is reported through — `output_truncated` is the existing code. */
const TRUNCATION_CODE = 'output_truncated';

export interface ResponseBudgetResult {
  /** The payload to serialize. Equal to the input when nothing had to be removed. */
  readonly payload: JsonValue;
  /**
   * How much the delivery had to give up, as warning entries to append to the payload's `warnings`.
   * Empty when the payload fits.
   */
  readonly warnings: readonly JsonValue[];
  /** The estimated serialized size after degradation, in bytes. */
  readonly estimatedBytes: number;
  /** True when anything was removed, so callers can tell "fits" from "was made to fit". */
  readonly degraded: boolean;
}

/**
 * How many bytes a value costs once serialized.
 *
 * An ESTIMATE, and deliberately a conservative one: it counts a JavaScript string's UTF-16 length
 * rather than its UTF-8 byte length (so non-ASCII costs more here than on the wire) and ignores that
 * `JSON.stringify` escapes some characters. Overestimating is the safe direction — the ceiling is a
 * hard cliff, so being a little pessimistic costs a few characters of context while being optimistic
 * costs the whole session.
 */
export function estimatedJsonBytes(value: unknown): number {
  if (value === null) {
    return 4;
  }
  switch (typeof value) {
    case 'string':
      return value.length + 2; // quotes
    case 'number':
    case 'boolean':
      return String(value).length;
    case 'undefined':
      return 0;
    case 'object': {
      if (Array.isArray(value)) {
        let total = 2; // brackets
        for (const entry of value) {
          total += estimatedJsonBytes(entry === undefined ? null : entry) + 1;
        }
        return total;
      }
      let total = 2; // braces
      for (const [key, entry] of Object.entries(value)) {
        total += key.length + 3 + estimatedJsonBytes(entry) + 1;
      }
      return total;
    }
    default:
      return 0;
  }
}

/** The fields that carry user text, and so are the ones worth truncating when the frame is too big. */
const TEXT_FIELDS = ['text', 'value', 'html'] as const;

/**
 * Enforce `maxBytes` on a tool payload, reporting whatever had to be removed.
 *
 * `maxBytes` is the budget for the TEXT frame; image blocks are counted separately by the caller,
 * because they travel as their own content blocks and their degradation is a different decision
 * (drop the block, keep the `artifact_path` that the payload already carries).
 */
export function enforceResponseBudget(payload: JsonValue, maxBytes: number): ResponseBudgetResult {
  const initial = estimatedJsonBytes(payload);
  if (initial <= maxBytes) {
    return { payload, warnings: [], estimatedBytes: initial, degraded: false };
  }

  // Copy, so a caller holding the original cannot observe a half-degraded payload. The copy is
  // shallow-then-structural: only the containers this function actually rewrites are cloned.
  const working = structuredClone(payload) as Record<string, JsonValue>;
  let size = initial;
  let truncatedFields = 0;
  let removedItems = 0;

  /**
   * Shrink the largest strings first.
   *
   * Largest-first is what makes the budget affordable: a run whose outputs are mostly small should
   * lose the ONE enormous `text/plain` result rather than a hundred useful previews, and it reaches
   * the budget in the fewest edits. Each pass recomputes nothing — the estimate is adjusted by the
   * difference each edit makes.
   */
  for (;;) {
    if (size <= maxBytes) {
      break;
    }
    const biggest = findLargestTextField(working);
    if (biggest === null) {
      break;
    }
    const { container, key, length } = biggest;
    // Give back the overshoot plus a margin, and keep at least a readable prefix so the model can see
    // WHAT was truncated — a field reduced to nothing is indistinguishable from an absent one.
    const overshoot = size - maxBytes;
    const keep = Math.max(200, length - overshoot - 512);
    container[key] = `${(container[key] as string).slice(0, keep)}…[truncated to fit the response budget]`;
    size += estimatedJsonBytes(container[key]) - (length + 2);
    truncatedFields += 1;
  }

  // Still too big with every text field cut down: the payload is made of many items, and the answer is
  // to drop whole ones so the model gets a truthful, smaller document instead of an undeliverable one.
  // Arrays of outputs are the only place where dropping is both safe and explainable.
  for (;;) {
    if (size <= maxBytes) {
      break;
    }
    const target = findDroppableArray(working);
    if (target === null) {
      break;
    }
    const last = target.array.pop();
    if (last === undefined) {
      break;
    }
    size -= estimatedJsonBytes(last) + 1;
    removedItems += 1;
  }

  const warnings: JsonValue[] = [];
  if (truncatedFields > 0) {
    // Counted separately from streams: a stream cut at `inline_text_chars` is the documented per-item
    // limit, while these were cut because the WHOLE response would not have fitted. A client that
    // wants the rest can narrow its request (fewer `cell_indexes`, `include_outputs: 'summary'`).
    const warning = createWarning(
      TRUNCATION_CODE,
      `${String(truncatedFields)} text value(s) were truncated because the response exceeded the ${String(Math.floor(maxBytes / 1024 / 1024))} MiB response budget`,
    );
    warnings.push({ code: warning.code, message: warning.message });
  }
  if (removedItems > 0) {
    const warning = createWarning(
      TRUNCATION_CODE,
      `${String(removedItems)} output item(s) were dropped because the response exceeded the ${String(Math.floor(maxBytes / 1024 / 1024))} MiB response budget; ask for fewer cells`,
    );
    warnings.push({ code: warning.code, message: warning.message });
  }

  if (warnings.length > 0) {
    const existing = working['warnings'];
    working['warnings'] = [...(Array.isArray(existing) ? existing : []), ...warnings];
    size = estimatedJsonBytes(working);
  }

  return { payload: working, warnings, estimatedBytes: size, degraded: warnings.length > 0 };
}

interface TextField {
  readonly container: Record<string, JsonValue>;
  readonly key: (typeof TEXT_FIELDS)[number];
  readonly length: number;
}

/** The largest string still present in one of the text-carrying fields, or null if none remains. */
function findLargestTextField(root: Record<string, JsonValue>): TextField | null {
  let best: TextField | null = null;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const record = node as Record<string, JsonValue>;
    for (const key of TEXT_FIELDS) {
      const value = record[key];
      if (typeof value === 'string' && (best === null || value.length > best.length)) {
        best = { container: record, key, length: value.length };
      }
    }
    for (const entry of Object.values(record)) {
      visit(entry);
    }
  };
  visit(root);
  return best;
}

interface DroppableArray {
  readonly array: JsonValue[];
}

/**
 * The longest array of output-shaped objects, or null.
 *
 * Restricted to arrays whose members are objects: those are output lists, where dropping an entry still
 * leaves a coherent document ("here are 3 of the 9 outputs"). Dropping a member of an arbitrary array
 * could break a shape the model has to reason about (`executed[].cell_index` would no longer describe
 * what ran), which is a different kind of lie.
 */
function findDroppableArray(root: Record<string, JsonValue>): DroppableArray | null {
  let best: JsonValue[] | null = null;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (
        node.length > 0 &&
        node.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) &&
        (best === null || node.length > best.length)
      ) {
        best = node as JsonValue[];
      }
      for (const entry of node) {
        visit(entry);
      }
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const entry of Object.values(node as Record<string, JsonValue>)) {
        visit(entry);
      }
    }
  };
  visit(root);
  return best === null ? null : { array: best };
}
