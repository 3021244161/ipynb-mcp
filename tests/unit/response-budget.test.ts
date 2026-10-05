import { describe, expect, it } from 'vitest';

import {
  TRUNCATION_MARKER,
  enforceResponseBudget,
  escapedByteLength,
  estimatedJsonBytes,
} from '../../src/core/response-budget.js';
import { reconcileTruncationFlags } from '../../src/mcp/render/read.js';

/**
 * [V14-11] The degradation loops must TERMINATE, and must never make a payload bigger.
 *
 * The first version of this module could hang the whole server. `keep = Math.max(200, length - overshoot -
 * 512)` exceeds a short field's own length, so the "truncated" value was the original PLUS a 37-character
 * marker: each pass grew the payload, `size` never fell, and the synchronous `for (;;)` never ended. Because
 * the loop is synchronous the event loop was held for good — the server stopped answering ANY request, not
 * just the one being served. Measured by the reviewer as a 30 s `McpError -32001: Request timed out` on a
 * read that a preview call answered in 76 ms.
 *
 * WHAT MAKES THESE CASES DISCRIMINATE. Termination is the property, so the assertion is termination: each
 * call must RETURN. That is not a value comparison and cannot be satisfied by accident — against the old
 * code these cases never return at all, which is exactly the defect. Every case therefore also carries a
 * timeout, so a regression fails as a timeout instead of hanging the suite.
 *
 * The shapes are the ones that reach the arithmetic: a payload whose bulk is NOT in a truncatable field (a
 * `source` array, a spread of small strings) and a tiny budget, where the only way out is the drop phase.
 */
describe('[V14-11] the budget loop terminates and never grows a value', () => {
  const smallFields = (count: number, length: number) => ({
    items: Array.from({ length: count }, () => 'y'.repeat(length)),
    warnings: [],
  });

  it('[V14-11] returns instead of spinning, for payloads no field can shorten', () => {
    const shapes: Array<[string, unknown]> = [
      // Nothing in a TEXT_FIELD at all: the bulk is a string array, so phase 1 has no candidate.
      ['source array only', { cells: [{ source: Array.from({ length: 200 }, () => 'w'.repeat(100)) }] }],
      // Fields present but far under the 200-character floor, so the old `Math.max(200, …)` made each one
      // LONGER and no pass could make progress.
      ['many fields under the floor', smallFields(500, 180)],
      ['one field just under the floor', { items: [{ text: 'z'.repeat(199) }, { text: 'z'.repeat(199) }] }],
      ['one field just over the floor', { items: [{ text: 'z'.repeat(237) }, { text: 'z'.repeat(237) }] }],
      ['a field of exactly the floor', { items: [{ text: 'q'.repeat(200) }] }],
      // The notebook shape the reviewer used: a big source array plus a small output.
      ['large source, small output', { cells: [{ source: ['x = 1'], outputs: [{ text: 'ok' }] }], padding: 'p'.repeat(50_000) }],
    ];
    for (const [label, payload] of shapes) {
      for (const budget of [256, 1024, 4096]) {
        const outcome = enforceResponseBudget(payload as never, budget);
        // The contract is that the call returns a payload; whether it reached the budget is secondary to
        // having returned at all. (The floor below the payload's real minimum is not always reachable, and
        // claiming otherwise would be the kind of assertion that gets relaxed later.)
        expect(outcome.payload, `${label} @ ${String(budget)}`).toBeDefined();
        expect(outcome.estimatedBytes).toBeGreaterThan(0);
      }
    }
  }, 30_000);

  it('[V14-11] a value that cannot be shortened is never made LONGER', () => {
    // Growing a value is how the loop failed to converge, so the guard is that nothing comes back bigger
    // than it went in. Two outcomes are legitimate — a degraded payload, or the explicit refusal — and the
    // assertion covers both because "the result is smaller or the answer is withheld" is the contract.
    const field = 'z'.repeat(150);
    const payload = { items: [{ kind: 'text', media_type: 'text/plain', text: field }], bulk: 'b'.repeat(4000) };
    const outcome = enforceResponseBudget(payload as never, 512);
    expect(outcome.estimatedBytes).toBeLessThanOrEqual(512);
    const body = outcome.payload as Record<string, unknown>;
    if (body['response_budget_exceeded'] === true) {
      // The refusal path: it must say so, and it must be small.
      expect(outcome.degraded).toBe(true);
      expect(JSON.stringify(body).length).toBeLessThan(2000);
      return;
    }
    const items = body['items'] as Array<Record<string, unknown>>;
    const text = String(items?.[0]?.['text'] ?? '');
    expect(text.length).toBeLessThanOrEqual(field.length + TRUNCATION_MARKER.length);
    if (text.includes(TRUNCATION_MARKER)) {
      expect(text.length).toBeLessThan(field.length + TRUNCATION_MARKER.length);
    }
  }, 30_000);

  it('[V14-11] the payload only ever shrinks across a degradation', () => {
    const payload = {
      cells: [{ outputs: [{ kind: 'text', text: 'a'.repeat(300_000) }] }],
      warnings: [],
    };
    const before = estimatedJsonBytes(payload);
    const outcome = enforceResponseBudget(payload as never, 1000);
    expect(outcome.estimatedBytes).toBeLessThan(before);
    expect(outcome.degraded).toBe(true);
  }, 30_000);
});

/**
 * [V14-13] The estimate is measured in the unit the CLIENT enforces.
 *
 * The SDK's `ReadBuffer` compares `Buffer.byteLength(jsonrpcLine)` against 10 MiB, and a string inside that
 * line is escaped by `JSON.stringify` — so `"`, `\` and control characters each become several bytes, and
 * non-ASCII becomes UTF-8. The first version counted UTF-16 units and ignored escaping, so it was low by
 * 2-6x on exactly this project's typical content: measured, 3 MiB of backslashes still killed the client
 * while 3 MiB of ASCII was fine, and a matrix of Chinese/emoji/control-character payloads went through
 * undegraded and killed it too.
 *
 * The assertion is against `Buffer.byteLength` of a real frame, which is the authority for "how big is
 * this on the wire" — not against this module's own arithmetic.
 */
describe('[V14-13] the size estimate counts bytes on the wire, not UTF-16 units', () => {
  /** The client-visible cost: bytes of the string as it appears inside the JSON-RPC line. */
  const framedBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;

  it('[V14-13] every escaping class is estimated at or above its real encoded size', () => {
    const samples: Array<[string, string]> = [
      ['ascii', 'x'.repeat(1000)],
      ['backslashes', '\\'.repeat(500)],
      ['double quotes', '"'.repeat(500)],
      ['windows path', 'C:\\Users\\a\\b\\c'.repeat(50)],
      ['control character', '\u0001'.repeat(500)],
      ['CJK', '中'.repeat(500)],
      ['emoji (surrogate pair)', '😀'.repeat(250)],
      ['latin-1 accents', 'é'.repeat(500)],
      ['mixed', 'a\\"中\u0001😀'.repeat(200)],
    ];
    for (const [label, value] of samples) {
      const real = framedBytes(value);
      const estimated = escapedByteLength(value);
      // NEVER LOW: an estimate below the truth lets through a frame that kills the session, which is the
      // whole defect. Being over is safe and costs a little truncation.
      expect(estimated, `${label}: estimated ${String(estimated)} < real ${String(real)}`).toBeGreaterThanOrEqual(real);
      // And not wildly over, or the budget would truncate content that fits comfortably.
      expect(estimated, `${label}: estimated ${String(estimated)} vs real ${String(real)}`).toBeLessThan(real * 2 + 8);
    }
  });

  it('[V14-13] a payload of backslashes is degraded before it can reach the frame limit', () => {
    // The reviewer's reproduction: 3 MiB of backslashes stayed under the old estimate, so the response went
    // out whole and the client died. The payload must be degraded, and the estimated size must be inside the
    // budget after degradation.
    const payload = { items: [{ kind: 'text', media_type: 'text/plain', text: '\\'.repeat(3 * 1024 * 1024) }], warnings: [] };
    const budget = 512 * 1024;
    const outcome = enforceResponseBudget(payload as never, budget);
    expect(outcome.degraded).toBe(true);
    expect(outcome.estimatedBytes).toBeLessThanOrEqual(budget);
    // The delivered text, measured the way the client measures it, is inside the budget too.
    const delivered = JSON.stringify(outcome.payload);
    expect(Buffer.byteLength(delivered, 'utf8')).toBeLessThan(10 * 1024 * 1024);
  }, 60_000);
});

/**
 * [F4] Dropping must remove OUTPUTS, not cells.
 *
 * The first version dropped from "the longest array of objects", which is `cells` whenever a notebook has
 * more cells than outputs — a measured response came back with `cells: []` next to `cell_count: 1`, and the
 * warning said an output had been dropped. A cell is the thing the caller asked about.
 */
describe('[V14-F4] the drop phase removes outputs and keeps every cell', () => {
  it('[F4] cells survive even when the payload is far over budget', () => {
    const cells = Array.from({ length: 20 }, (_, index) => ({
      cell_index: index,
      cell_type: 'code',
      outputs: Array.from({ length: 3 }, () => ({ kind: 'text', media_type: 'text/plain', text: 'o'.repeat(5000) })),
    }));
    // 32 KiB: room for 20 cell skeletons once their outputs are gone, and not enough for the outputs.
    const outcome = enforceResponseBudget({ path: 'x.ipynb', cells, cell_count: 20 } as never, 32 * 1024);
    const kept = (outcome.payload as Record<string, unknown>)['cells'] as unknown[];
    // Every cell is still described, and the count still agrees with what is there.
    expect(kept.length).toBe(20);
    expect((outcome.payload as Record<string, unknown>)['cell_count']).toBe(20);
    // The cell COUNT must agree with the array, which is the invariant v14 F4 was about: a response that
    // said `cells: []` next to `cell_count: 1` was incoherent.
    expect(kept.length).toBe((outcome.payload as Record<string, unknown>)['cell_count']);
    // Something WAS dropped, or this case would pass on a budget that never degrades.
    expect(outcome.degraded).toBe(true);
    expect(outcome.estimatedBytes).toBeLessThanOrEqual(32 * 1024);
  }, 30_000);
});

/**
 * [F8] The budget's size in a model-visible message must not be a rounded-down zero.
 *
 * With `--max-response-bytes 65536` the old wording said "exceeded the 0 MiB response budget", a false
 * number in the only explanation the model gets (the V11-12① family: a message must describe the payload
 * actually delivered).
 */
describe('[V14-F8] the warning describes the budget truthfully', () => {
  it('[F8] a sub-MiB budget is described in KiB, never as 0 MiB', () => {
    const payload = { items: [{ kind: 'text', media_type: 'text/plain', text: 'x'.repeat(100_000) }], warnings: [] };
    const outcome = enforceResponseBudget(payload as never, 65536);
    const messages = outcome.warnings.map((entry) => String((entry as Record<string, unknown>)['message']));
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toContain('0 MiB');
      expect(message).toContain('KiB');
    }
  }, 30_000);
});

/**
 * [V15-1] The budget must have a lever on whatever holds the bytes — including arrays of strings.
 *
 * `TEXT_FIELDS` looked only at scalar properties, so a payload whose bulk is `cells[].source` or
 * `source_preview` had NO lever at all: the reviewer measured a >10 MiB frame and `McpError -32000
 * Connection closed` for `include_source='full'` on a 5 MiB source — the exact shape this module exists
 * to prevent. The v14 fixtures were all large `text/plain` values, which is why they could not see it.
 *
 * Arrays are handled generically (any array of strings), not by listing the field names, because a list
 * has to be extended every time a projection adds one — and that is how this survived a round.
 */
describe('[V15-1] the budget shortens arrays of strings, not just scalar text', () => {
  it('[V15-1] a source-only payload is brought inside the budget', () => {
    const lines = Array.from({ length: 4000 }, (_, index) => `line ${String(index)} ${'s'.repeat(200)}\n`);
    const payload = { path: 'x.ipynb', cells: [{ cell_index: 0, source: lines, source_preview: [], source_line_count: lines.length }] };
    const before = estimatedJsonBytes(payload);
    const budget = 256 * 1024;
    const outcome = enforceResponseBudget(payload as never, budget);

    expect(outcome.degraded, 'a source-only payload must be degraded, not passed through').toBe(true);
    expect(outcome.estimatedBytes).toBeLessThanOrEqual(budget);
    expect(outcome.estimatedBytes).toBeLessThan(before);
    // The field is still an array of strings — the lever must not change a field's type, which would break
    // the shape the model reads.
    const cells = (outcome.payload as Record<string, unknown>)['cells'] as Array<Record<string, unknown>>;
    // `cells[0]` is asserted before its `source` is used, so the optional chaining is not load-bearing: if a
    // future change dropped the cell, the failure would say "expected undefined to be an object" here rather
    // than surfacing as a confusing TypeError inside the next assertion.
    const cell = cells[0] as Record<string, unknown> | undefined;
    expect(cell, JSON.stringify(outcome.payload).slice(0, 200)).toBeDefined();
    const kept = cell?.['source'] as string[] | undefined;
    expect(Array.isArray(kept)).toBe(true);
    expect(kept!.length).toBeGreaterThan(0);
    expect(kept!.length).toBeLessThan(lines.length);
    // And the warning names the field, so the model knows what it is missing.
    const messages = outcome.warnings.map((entry) => String((entry as Record<string, unknown>)['message']));
    expect(messages.join(' ')).toContain('source');
  }, 30_000);

  it('[V15-1] the guarantee is unconditional: a payload that cannot be reduced becomes a refusal', () => {
    // A payload of many small scalars in fields the lever cannot reach: `metadata` is arbitrary JSON, and
    // these are numbers, so nothing can be shortened and nothing can be dropped (there is no `outputs`).
    const payload = {
      path: 'x.ipynb',
      cell_count: 1,
      metadata: Object.fromEntries(Array.from({ length: 8000 }, (_, index) => [`k${String(index)}`, 1234567890])),
    };
    const budget = 4096;
    const outcome = enforceResponseBudget(payload as never, budget);
    expect(outcome.estimatedBytes, 'the frame must never leave above the budget').toBeLessThanOrEqual(budget);
    expect(outcome.degraded).toBe(true);
    const body = outcome.payload as Record<string, unknown>;
    expect(body['response_budget_exceeded']).toBe(true);
    // The refusal keeps the identifying fields a caller needs to act, and names the way out.
    expect(body['path']).toBe('x.ipynb');
    const messages = (body['warnings'] as Array<Record<string, unknown>>).map((entry) => String(entry['message']));
    expect(messages.join(' ')).toContain('cell_indexes');
  }, 30_000);
});

/**
 * [V16-1] A structured completeness flag must not outlive the value it describes.
 *
 * `source_truncated` is what a model reads to decide whether the source it holds is the whole source
 * (SPEC §4.1). The budget can shorten `source`/`source_preview` AFTER projection, and it edits JSON, so it
 * cannot know that a boolean beside the value is meant to describe it. Measured by the reviewer before this
 * was fixed: a 12 MiB source arrived as 8 387 552 characters ending in the truncation marker while the payload
 * said `source_truncated: false` — the structural field contradicting the value next to it, which is worse
 * than having no field, because a model that trusts the flag concludes the source is complete.
 *
 * The division of labour is what makes this testable without teaching the budget about read semantics: the
 * budget reports WHERE it cut, and the render layer reconciles its own flags.
 */
describe('[V16-1] reconcileTruncationFlags keeps the flags honest', () => {
  const cellPayload = (extra: Record<string, unknown>) => ({
    path: 'x.ipynb',
    cell_count: 1,
    cells: [{ cell_index: 0, source_line_count: 740_173, source_truncated: false, ...extra }],
  });

  it('[V16-1] a shortened `source` sets source_truncated', () => {
    // The delivered string ENDS WITH THE MARKER the budget appends, which is what the reconciliation reads.
    const payload = cellPayload({ source: 'y = 1  # padding…[truncated to fit the response budget]' });
    const reconciled = reconcileTruncationFlags(payload as never, ['source']) as Record<string, unknown>;
    const cell = ((reconciled['cells'] ?? []) as Array<Record<string, unknown>>)[0] ?? {};
    expect(cell['source_truncated']).toBe(true);
  });

  it('[V16-1] a shortened `source_preview` is flagged, and a complete one beside it is not', () => {
    const marker = 'ab…[truncated to fit the response budget]';
    const payload = {
      path: 'x.ipynb',
      cell_count: 3,
      cells: [
        // The budget cut this cell's preview, so its last delivered element carries the marker.
        { cell_index: 0, source: null, source_preview: ['a', 'b', marker], source_line_count: 500, source_truncated: false },
        // Complete, so it must NOT be flagged. This is the case the first version got wrong: it flagged every
        // cell that delivered anything as soon as the field appeared in the cut list.
        { cell_index: 1, source: null, source_preview: ['c\n', 'd\n'], source_line_count: 3, source_truncated: false },
        // `include_source='none'` delivers neither field — flagging it would claim a source was cut in a
        // request that asked for no source at all.
        { cell_index: 2, source: null, source_preview: [], source_line_count: 9, source_truncated: false },
      ],
    };
    const reconciled = reconcileTruncationFlags(payload as never, ['source_preview']) as Record<string, unknown>;
    const cells = (reconciled['cells'] ?? []) as Array<Record<string, unknown>>;
    expect(cells[0]?.['source_truncated']).toBe(true);
    expect(cells[1]?.['source_truncated']).toBe(false);
    expect(cells[2]?.['source_truncated']).toBe(false);
  });

  it('[V16-1] a value without the marker is never called truncated', () => {
    // The flag follows the VALUE, not the call's cut list: a 4-character cell in a response where another cell
    // was cut must still report itself complete.
    const payload = {
      path: 'x.ipynb',
      cells: [
        { cell_index: 1, source: '# a short heading', source_line_count: 1, source_truncated: false },
      ],
    };
    const reconciled = reconcileTruncationFlags(payload as never, ['source']) as Record<string, unknown>;
    const cell = ((reconciled['cells'] ?? []) as Array<Record<string, unknown>>)[0] ?? {};
    expect(cell['source_truncated']).toBe(false);
  });

  it('[V16-1] nothing is touched when nothing was cut', () => {
    // A single-line cell whose declaration agrees with what is delivered.
    const payload = {
      path: 'x.ipynb',
      cell_count: 1,
      cells: [{ cell_index: 0, source: 'x = 1', source_line_count: 1, source_truncated: false }],
    } as unknown;
    const reconciled = reconcileTruncationFlags(payload as never, []);
    // Same object, not a copy: the reconciliation must not rewrite payloads the budget left alone.
    expect(reconciled).toBe(payload);
  });

  it('[V16-1] a cut in an unrelated field leaves the source flags alone', () => {
    const payload = {
      path: 'x.ipynb',
      cell_count: 1,
      cells: [{ cell_index: 0, source: 'x = 1', source_line_count: 1, source_truncated: false }],
    };
    const reconciled = reconcileTruncationFlags(payload as never, ['text']) as Record<string, unknown>;
    const cell = ((reconciled['cells'] ?? []) as Array<Record<string, unknown>>)[0] ?? {};
    expect(cell['source_truncated']).toBe(false);
  });

  it('[V16-1] the budget reports the fields it cut, deduplicated', () => {
    // `source` shortened over several passes must appear once, and a payload that fits reports nothing.
    const lines = Array.from({ length: 4000 }, (_, index) => `line ${String(index)} ${'s'.repeat(200)}`);
    const payload = { path: 'x.ipynb', cells: [{ source: lines, source_truncated: false }] };
    const cut = enforceResponseBudget(payload as never, 64 * 1024);
    expect(cut.truncatedFields).toEqual(['source']);
    expect(new Set(cut.truncatedFields).size).toBe(cut.truncatedFields.length);

    const fits = enforceResponseBudget({ path: 'x.ipynb' } as never, 64 * 1024);
    expect(fits.truncatedFields).toEqual([]);
    expect(fits.degraded).toBe(false);
  });
});
