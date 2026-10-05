// The whole-response budget (review v13 V13-1; rewritten for v14 V14-11/V14-12/V14-13).
//
// WHY THIS EXISTS. Every tool result travels to the client as ONE newline-delimited JSON-RPC frame, and
// the MCP SDK's `ReadBuffer` rejects a frame larger than `STDIO_DEFAULT_MAX_BUFFER_SIZE` by throwing —
// the client's connection dies with `McpError -32000: Connection closed` and every later call answers
// "Not connected". Nothing in this server bounded a response: the only limit was `inline_text_chars`, and
// it applied to `stream` items ONLY, so a `text/plain`, `text/html`, `application/json` or image output of
// any size went straight through. Measured with a real SDK client: 9.9 MiB succeeded silently, 10.2 MiB
// killed the session, and 60 small items totalling 17.6 MiB killed it too — the cliff is on the FRAME, not
// on any one item. The worst instance is a `notebook_run`: the outputs are written to the user's file
// successfully and the model never learns the run happened.
//
// So this module enforces a byte budget on the frame BEFORE it is sent, degrading the payload rather than
// truncating the JSON (which would hand the model a parse error). Everything it removes is reported:
// SPEC §5.4's rule is that truncation is never silent.
//
// A DEVIATION, recorded as D-065: SPEC §5.4 and §7 describe truncation only for stream thresholds and say
// nothing about a total response size, because the 10 MiB ceiling lives in the transport (the SDK), not in
// the format. Per AGENTS §0 the deviation is registered rather than resolved by editing the SPEC.
//
// THREE THINGS THE FIRST VERSION GOT WRONG (v14: all three found by review, all three measured, and the
// first was worse than the defect it was written to fix):
//
//   V14-11  THE TRUNCATION LOOP DID NOT CONVERGE. `keep = Math.max(200, length - overshoot - 512)` could
//           exceed the field's own length, so the "truncated" value was the original PLUS a marker: every
//           pass made the payload BIGGER, and the synchronous `for (;;)` never ended. The event loop was
//           held for good: the server stopped answering ANY request, not just that one. A loop whose job is
//           to make a payload smaller must PROVE each pass made progress.
//   V14-12  The budget ran on the SUCCESS path only. Error responses were stringified raw, and
//           `detail.executed[]` carries outputs, so a run that produced a large output and then timed out
//           sent an unbounded frame — the worst shape of all, because the file had already been written
//           back while the model learned neither the timeout nor which cells completed.
//   V14-13  THE SIZE ESTIMATE MEASURED THE WRONG THING. It counted UTF-16 code units and ignored JSON
//           escaping, while the SDK's limit is the UTF-8 BYTE length of the serialized line. A backslash,
//           quote or control character is escaped as `\u00XX` — one input character becoming six bytes — so
//           the estimate was low by 2-6x on exactly the content this project's users have (Chinese
//           notebooks, Windows paths, printed JSON). Measured: 3 MiB of backslashes still killed the client
//           while 3 MiB of ASCII was fine.
//
// `tests/unit/response-budget.test.ts` pins all three, each with the mutation that makes it red.

import { createWarning, type JsonValue } from './errors.js';

/** The warning every degradation is reported through — `output_truncated` is the existing code. */
const TRUNCATION_CODE = 'output_truncated';

/** Appended to whatever survives a truncation, so the model can see the value was cut. */
export const TRUNCATION_MARKER = '…[truncated to fit the response budget]';

/**
 * Hard stop for each degradation loop.
 *
 * A named cap turns "this cannot terminate" into a bounded, throwable condition. The loops are written to
 * converge — every pass must strictly reduce the measured size — so this is a backstop against a future
 * edit, not part of the algorithm. Generous on purpose: thousands of legitimate passes happen when a
 * payload is made of thousands of small items.
 */
const MAX_DEGRADATION_PASSES = 10_000;

/**
 * The cap actually used for one payload: enough for every element the payload could need shortening, never
 * more than the constant. A payload legitimately made of thousands of large strings needs one pass each, and
 * a cap that ignored the payload's size would refuse work that is perfectly bounded.
 */
function passBudgetFor(elementCount: number): number {
  return Math.min(MAX_DEGRADATION_PASSES, Math.max(64, elementCount * 2));
}

/** How many containers the payload holds — the passes a full degradation could legitimately need. */
function countStrings(root: unknown): number {
  let count = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      count += 1;
      for (const entry of node) {
        visit(entry);
      }
      return;
    }
    if (typeof node === 'object' && node !== null) {
      count += 1;
      for (const entry of Object.values(node as Record<string, unknown>)) {
        visit(entry);
      }
    }
  };
  visit(root);
  return count;
}

/** The fields that carry user text, and so are the ones worth shortening when the frame is too big. */
const TEXT_FIELDS = ['text', 'value', 'html'] as const;

/**
 * How large a string has to be before the budget will cut it whatever its field is called.
 *
 * 64 KiB: far above any scalar the payload carries for identification (paths, ids, hashes, media types) and
 * far below anything that can dominate a response. Below this, cutting a field would be all cost and no
 * benefit — the payload would lose meaning while the frame stayed the same size.
 */
const GENERIC_STRING_FLOOR_BYTES = 64 * 1024;

export interface ResponseBudgetResult {
  /** The payload to serialize. Equal to the input when nothing had to be removed. */
  readonly payload: JsonValue;
  /**
   * How much the delivery had to give up, as warning entries to append to the payload's `warnings`. Empty
   * when the payload fits.
   */
  readonly warnings: readonly JsonValue[];
  /** The measured size after degradation, in bytes of the serialized frame. */
  readonly estimatedBytes: number;
  /** True when anything was removed, so callers can tell "fits" from "was made to fit". */
  readonly degraded: boolean;
  /**
   * The FIELDS that were shortened or dropped, deduplicated: `['source']`, `['outputs', 'text']`, …
   *
   * A payload can carry a STRUCTURED FLAG that describes a field's completeness — `source_truncated` for
   * `source`/`source_preview` (SPEC §4.1) — and a flag that still says "complete" after the value was cut is
   * worse than no flag: the model reads the field, not the string, so it concludes the source it holds is the
   * whole source (review v16 V16-1). The budget cannot fix that itself: it edits JSON and knows nothing about
   * what any field MEANS. So it reports WHERE it cut, and the layer that owns the semantics reconciles its own
   * flags — see `reconcileTruncationFlags` in `src/mcp/render/read.ts`.
   */
  readonly truncatedFields: readonly string[];
}

/**
 * Bytes this string costs inside a JSON frame, ESCAPING INCLUDED.
 *
 * The SDK measures `Buffer.byteLength(line)` where `line` is `JSON.stringify(message)`, and a string inside
 * that is escaped AGAIN by the outer serialization. So one input character can cost six bytes on the wire:
 * `"` and `\` become `\"`/`\\` (four bytes each counting their own escape) and a control character becomes
 * `\u00XX` (twelve, because the backslash is itself escaped).
 *
 * This mirrors escaping rather than approximating it, because the budget's whole value is that the estimate
 * is never LOW: an estimate that is low lets through a frame that kills the client, which is the defect
 * this module exists to remove (v14 V14-13).
 */
export function escapedByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 4;
    } else if (code < 0x20) {
      bytes += 12;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes + 2; // the surrounding quotes
}

/**
 * Bytes this value costs once serialized into a frame.
 *
 * Not `JSON.stringify(value).length`: that is UTF-16 units of an already-escaped string, which is wrong in
 * both directions on non-ASCII content.
 */
export function estimatedJsonBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return 4;
  }
  switch (typeof value) {
    case 'string':
      return escapedByteLength(value);
    case 'number':
    case 'boolean':
      return String(value).length;
    case 'object': {
      if (Array.isArray(value)) {
        let total = 2; // brackets
        for (const entry of value) {
          total += estimatedJsonBytes(entry) + 1; // comma
        }
        return total;
      }
      let total = 2; // braces
      for (const [key, entry] of Object.entries(value)) {
        total += escapedByteLength(key) + 1 + estimatedJsonBytes(entry) + 1; // colon + comma
      }
      return total;
    }
    default:
      return 0;
  }
}

/** `8.00 MiB`, and never `0 MiB` for a budget that is merely small (v14 F8: the model read a false number). */
function describeBudget(maxBytes: number): string {
  const mib = maxBytes / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(2)} MiB` : `${String(Math.round(maxBytes / 1024))} KiB`;
}

/**
 * One place the budget can take bytes from.
 *
 * `scalar` is a string in a TEXT_FIELD; `lines` is an array of strings, which is what `source` and
 * `source_preview` are — the shape that made the budget powerless (v15 V15-1). Both are ranked by the
 * bytes they cost, so the largest holder of user text is shortened first whichever kind it is.
 */
interface ShrinkableField {
  readonly container: Record<string, JsonValue>;
  readonly key: string;
  /**
   * `scalar` = a TEXT_FIELD string (marker appended), `text` = any other large string (same treatment,
   * reported under the field's own name), `lines` = an array of strings.
   */
  readonly kind: 'scalar' | 'text' | 'lines';
  /** Characters (scalar) or elements (lines) — only used to clamp the target below the current size. */
  readonly length: number;
  /** Bytes this field costs now, so a rewrite is measured rather than assumed. */
  readonly bytes: number;
}

/**
 * The largest string still present in a text-carrying field, or null if none is left to try.
 *
 * `skip` holds fields a pass already failed to shrink. Trying one of those again would recreate the
 * non-convergence this module was rewritten to remove, so they are left untouched and the drop phase takes
 * over: losing a whole item is worse for the model than losing part of one, but it is bounded, and a
 * response that never arrives is worse than both.
 */
function findLargestField(root: Record<string, JsonValue>, skip: ReadonlySet<string>): ShrinkableField | null {
  let best: ShrinkableField | null = null;
  const consider = (candidate: ShrinkableField): void => {
    if (skip.has(fieldKey(candidate.container, candidate.key))) {
      return;
    }
    if (best === null || candidate.bytes > best.bytes) {
      best = candidate;
    }
  };
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
    for (const [key, value] of Object.entries(record)) {
      // ANY large string, whatever the field is called. Restricting this to `TEXT_FIELDS` was the defect:
      // `source` is a plain string of the whole cell in this path and is not in that list, so the 7 MiB
      // that dominated the payload was unreachable and the response was refused instead of shortened
      // (review v15 V15-1, found by dumping the payload shape at the moment of refusal). A name list has to
      // be extended whenever a projection adds a field; "large string" does not.
      if (
        typeof value === 'string' &&
        escapedByteLength(value) > GENERIC_STRING_FLOOR_BYTES &&
        // Below the marker's own length there is nothing to give: `slice(0, target) + marker` would be
        // LONGER than the value it replaces, so such a field is not a candidate at all.
        value.length > TRUNCATION_MARKER.length + 1
      ) {
        consider({
          container: record,
          key,
          kind: (TEXT_FIELDS as readonly string[]).includes(key) ? 'scalar' : 'text',
          length: value.length,
          bytes: escapedByteLength(value),
        });
        continue;
      }
      // An array of strings, whatever it is called: `source`, `source_preview`, a traceback, a cell's
      // lines. Generic on purpose — a list of names would have to be extended every time a projection
      // adds a string array, which is how this defect survived a round (v15 V15-1).
      if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string')) {
        let bytes = 2;
        for (const entry of value as string[]) {
          bytes += escapedByteLength(entry) + 1;
        }
        consider({ container: record, key, kind: 'lines', length: value.length, bytes });
      }
    }
    for (const entry of Object.values(record)) {
      visit(entry);
    }
  };
  visit(root);
  return best;
}

/**
 * Identity for one field, so a failed shrink can be remembered without holding the container.
 *
 * A `WeakMap` from container to id keeps this from leaking references, and `containerId` is the only way to
 * express "this object, in the copy I am mutating" in a primitive key.
 */
const containerIds = new WeakMap<object, number>();
let nextContainerId = 0;

function fieldKey(container: object, key: string): string {
  let id = containerIds.get(container);
  if (id === undefined) {
    nextContainerId += 1;
    id = nextContainerId;
    containerIds.set(container, id);
  }
  return `${String(id)}:${key}`;
}

/**
 * The longest `outputs` array, or null.
 *
 * ONLY arrays under an `outputs` key are eligible, and that restriction is a fix (v14 F4): choosing "the
 * longest array of objects" picked `cells` whenever a notebook had more cells than outputs, so the drop
 * phase deleted whole CELLS — a measured response reported `cells: []` next to `cell_count: 1` while the
 * warning said an output had been dropped. Dropping an output is explainable and leaves the document
 * coherent; dropping a cell removes the thing the caller asked about.
 */
function findDroppableOutputs(root: Record<string, JsonValue>): JsonValue[] | null {
  let best: JsonValue[] | null = null;
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
    const outputs = record['outputs'];
    if (
      Array.isArray(outputs) &&
      outputs.length > 0 &&
      outputs.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) &&
      (best === null || outputs.length > best.length)
    ) {
      best = outputs as JsonValue[];
    }
    for (const entry of Object.values(record)) {
      visit(entry);
    }
  };
  visit(root);
  return best;
}

/**
 * Enforce `maxBytes` on a tool payload, reporting whatever had to be removed.
 *
 * `maxBytes` is the budget for the serialized frame. Image blocks are counted separately by the caller,
 * because they travel as their own content blocks and their degradation is a different decision (drop the
 * block, keep the `artifact_path` the payload already carries).
 *
 * Callers must pass the FINAL payload — see `src/mcp/tools/result.ts`, which applies this on both the
 * success and the failure exit, since an error body carries `detail.executed[]` and is just as able to
 * exceed the frame limit (v14 V14-12).
 */
export function enforceResponseBudget(payload: JsonValue, maxBytes: number): ResponseBudgetResult {
  const initial = estimatedJsonBytes(payload);
  if (initial <= maxBytes) {
    return { payload, warnings: [], estimatedBytes: initial, degraded: false, truncatedFields: [] };
  }

  // A deep copy, so a caller holding the original cannot observe a half-degraded payload.
  // `structuredClone` is the only correct way to do that, and the cost — one payload-sized copy — is paid
  // only on the rare path where the payload does not fit and the alternative is the client losing the whole
  // session (v14 F7 corrected the comment that claimed this was a partial clone).
  const working = structuredClone(payload) as Record<string, JsonValue>;
  let size = initial;

  // Enough passes for every element that could need shortening, capped by the constant above.
  const passLimit = passBudgetFor(countStrings(working));
  const unshrinkable = new Set<string>();
  let truncatedFields = 0;
  let removedItems = 0;
  let passes = 0;

  const guardPasses = (): void => {
    passes += 1;
    if (passes > passLimit) {
      // Unreachable while every pass makes progress; a loud failure beats a silent spin.
      throw new Error(
        `response budget cannot be satisfied: ${String(MAX_DEGRADATION_PASSES)} passes and still ${String(size)} > ${String(maxBytes)}`,
      );
    }
  };

  // Phase 1: shorten the largest holder of user text first — a scalar string or an array of lines.
  // Largest-first is what makes the budget affordable: a run whose outputs are mostly small should lose
  // the ONE enormous result rather than a hundred previews.
  // Keyed by field name: the warning has to say WHICH field it shortened, or the model cannot act on it
  // (v15 V15-2 — the array path already named its field and the scalar path did not).
  const shortenedScalars: string[] = [];
  const shortenedArrays: Array<{ key: string; owner: Record<string, JsonValue>; omitted: number }> = [];
  for (;;) {
    if (size <= maxBytes) {
      break;
    }
    guardPasses();
    const biggest = findLargestField(working, unshrinkable);
    if (biggest === null) {
      break;
    }
    const { container, key, kind, length, bytes } = biggest;
    const overshoot = size - maxBytes;
    // PROGRESS IS REQUIRED: the target is clamped strictly below the current size, because `Math.max` used
    // to win whenever the arithmetic went negative and the "truncated" value was then the ORIGINAL plus a
    // marker — longer than what it replaced (v14 V14-11).
    const target = Math.min(length - 1, Math.max(kind === 'lines' ? 1 : 200, length - overshoot - 512));

    if (kind === 'lines') {
      const lines = container[key] as string[];
      if (lines.length > 1) {
        // Dropping whole elements first: it keeps the value's shape and is the cheapest change.
        const keep = Math.max(1, Math.min(lines.length - 1, target));
        const dropped = lines.slice(keep);
        let droppedBytes = 0;
        for (const entry of dropped) {
          droppedBytes += escapedByteLength(entry) + 1;
        }
        const remainingBytes = bytes - droppedBytes;
        if (remainingBytes >= bytes) {
          unshrinkable.add(fieldKey(container, key));
          continue;
        }
        container[key] = lines.slice(0, keep);
        size += remainingBytes - bytes;
        shortenedArrays.push({ key, owner: container, omitted: dropped.length });
      } else {
        // ONE element and it is too big: there is no element to drop, so the ELEMENT is cut. A notebook
        // written by a machine usually holds one joined string per cell rather than a line per element, and
        // without this branch the array lever had nothing to do — the payload fell through to the refusal
        // even when slicing one string would have fitted it (measured: 8.97 MiB refused at an 8 MiB budget).
        //
        // The bound is the ELEMENT's length, not the array's: `length` is 1 here, so an array-sized target
        // asks for a one-character string and the slice cannot make progress.
        const only = lines[0] ?? '';
        // `Math.min` with the value's own length minus the marker and one character: the marker is appended
        // AFTER the slice, so a slice that leaves no room for it produces a LONGER value, and a longer value
        // grows the payload (measured: a 5-character value became 40 and the loop never ended).
        const keepChars = Math.max(
          1,
          Math.min(only.length - TRUNCATION_MARKER.length - 1, only.length - overshoot - 512),
        );
        const sliced = `${only.slice(0, keepChars)}${TRUNCATION_MARKER}`;
        const slicedBytes = escapedByteLength(sliced) + 2; // the array's own brackets
        if (slicedBytes >= bytes) {
          // No net progress: leave the value exactly as it was and stop considering this field.
          unshrinkable.add(fieldKey(container, key));
          continue;
        }
        container[key] = [sliced];
        size += slicedBytes - bytes;
      }
    } else {
      // A scalar string. `text` (any other large string) is treated exactly like a TEXT_FIELD: the marker
      // says "this was cut" in the value itself, which needs no new field in any schema.
      const replacement = target <= 0 ? '' : `${(container[key] as string).slice(0, target)}${TRUNCATION_MARKER}`;
      const nowBytes = escapedByteLength(replacement);
      if (nowBytes >= bytes) {
        unshrinkable.add(fieldKey(container, key));
        continue;
      }
      container[key] = replacement;
      shortenedScalars.push(key);
      size += nowBytes - bytes;
    }
    truncatedFields += 1;
    // `continue` is implicit: every branch above either made progress or skipped the field.
  }

  // Phase 2: still too big with every text field shortened, so whole OUTPUT items go.
  for (;;) {
    if (size <= maxBytes) {
      break;
    }
    guardPasses();
    const outputs = findDroppableOutputs(working);
    if (outputs === null) {
      break;
    }
    const last = outputs.pop();
    if (last === undefined) {
      break;
    }
    size -= estimatedJsonBytes(last) + 1;
    removedItems += 1;
  }

  // ONE WARNING, whichever phases ran. SPEC §7 defines `output_truncated` as a per-CALL warning and U21b
  // asserts exactly one; the first version emitted one per phase, so a payload that needed both shortening
  // and omission carried two entries with the same code — a shape the spec forbids and the existing
  // assertion would have caught if any fixture had needed both phases (v14 F5).
  const warnings: JsonValue[] = [];
  if (truncatedFields > 0 || removedItems > 0) {
    const parts: string[] = [];
    if (shortenedScalars.length > 0) {
      // Named, deduplicated, and bounded: a payload can hold thousands of shortened fields, and the warning
      // must not become a response-size lever of its own (the V11-7 lesson about message length).
      const names = [...new Set(shortenedScalars)].filter((name) => name.length <= 64).slice(0, 8);
      parts.push(
        `${String(shortenedScalars.length)} value(s) in ${names.map((name) => `\`${name}\``).join(', ')} shortened (marked \`${TRUNCATION_MARKER}\`)`,
      );
    }
    for (const entry of shortenedArrays) {
      // "which field, how much" — the two facts a model needs to know what it is missing. The field NAMES
      // are the payload's own (`source`, `source_preview`), so the reader can map them back.
      parts.push(`${String(entry.omitted)} item(s) omitted from \`${entry.key}\``);
    }
    if (removedItems > 0) {
      parts.push(`${String(removedItems)} output item(s) omitted`);
    }
    // The advice has to hold for the common case, which is ONE cell whose ONE output is large: "ask for
    // fewer cells" was not actionable there (v14 V14-2). Where the whole value still is, and how to get at
    // it in pieces, are true either way.
    warnings.push(
      warning(
        `${parts.join('; ')} to fit the ${describeBudget(maxBytes)} response budget. The notebook still holds every value on disk: read it in parts with \`cell_indexes\`, use \`include_outputs='summary'\` for previews, or raise \`--max-response-bytes\` if your client's limit allows`,
      ),
    );
  }

  if (warnings.length > 0) {
    const existing = working['warnings'];
    working['warnings'] = [...(Array.isArray(existing) ? existing : []), ...warnings];
    size = estimatedJsonBytes(working);
  }

  // THE LAST RESORT: the frame must never leave here above the budget.
  //
  // Everything above tries to keep the payload ANSWER-SHAPED while fitting — shorten the biggest text,
  // shorten arrays, drop outputs. That covers the shapes a projection produces today, but a future field
  // can always hold the bulk of a response in a place none of those reach, and the consequence is not a
  // degraded answer: it is `McpError -32000 Connection closed`, no error code, and every kernel on that
  // server dying with the session (the V13-1 shape). So when the payload still does not fit, the answer
  // stops pretending to be the document and becomes an explicit refusal carrying the reason and the way
  // out. Refusing is worse than answering and better than killing the session — and "better than both" is
  // not available, because a payload that cannot be shortened is by definition already all substance.
  //
  // Measured: `include_source='full'` on a 5 MiB source produced a >10 MiB frame here before the array
  // lever existed (review v15 V15-1), and the fix for that is the `lines` handling above. This branch is
  // what makes the guarantee unconditional rather than dependent on knowing every field in advance.
  if (size > maxBytes) {
    const refusal = refusalPayload(payload, maxBytes, size);
    return {
      payload: refusal,
      warnings: [...warnings],
      estimatedBytes: estimatedJsonBytes(refusal),
      degraded: true,
      // No field survives in the refusal, so there is no flag left to reconcile — the payload says
      // `response_budget_exceeded` and nothing else.
      truncatedFields: [],
    };
  }

  return {
    payload: working,
    warnings,
    estimatedBytes: size,
    degraded: warnings.length > 0,
    // Deduplicated: a caller reconciling flags wants the set of affected FIELDS, and one cell can be cut
    // more than once (a long `source` shortened over several passes).
    truncatedFields: [...new Set([...shortenedScalars, ...shortenedArrays.map((entry) => entry.key)])],
  };
}

/**
 * A small, honest response for a payload that could not be brought inside the budget.
 *
 * It keeps the identifying fields a caller needs to act (`path`, `run_id`, whatever is small) and states
 * what happened, rather than dropping content and hoping the model does not notice. `notebook_read`'s
 * `cell_indexes` and the `include_*` switches are the real remedy, so they are named.
 */
function refusalPayload(original: JsonValue, maxBytes: number, size: number): JsonValue {
  const identity: Record<string, JsonValue> = {};
  if (typeof original === 'object' && original !== null && !Array.isArray(original)) {
    for (const [key, value] of Object.entries(original as Record<string, JsonValue>)) {
      // Only scalars, and only small ones: the point is a payload that certainly fits.
      if (typeof value === 'string' && value.length <= 300) {
        identity[key] = value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        identity[key] = value;
      }
    }
  }
  return {
    ...identity,
    response_budget_exceeded: true,
    warnings: [
      warning(
        `this response is about ${describeBudget(size)} and could not be reduced below the ${describeBudget(maxBytes)} budget. Nothing was sent, so no value is half-delivered: read the notebook in parts with \`cell_indexes\`, use \`include_source='none'\` or \`include_outputs='summary'\` for an overview, or raise \`--max-response-bytes\` if your client's limit allows`,
      ),
    ],
  };
}

function warning(message: string): JsonValue {
  const created = createWarning(TRUNCATION_CODE, message);
  return { code: created.code, message: created.message };
}
