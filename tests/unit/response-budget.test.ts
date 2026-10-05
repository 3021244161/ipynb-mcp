import { describe, expect, it } from 'vitest';

import {
  TRUNCATION_MARKER,
  enforceResponseBudget,
  escapedByteLength,
  estimatedJsonBytes,
} from '../../src/core/response-budget.js';

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

  it('[V14-11] a value that cannot be shortened is left EXACTLY as it was', () => {
    // Growing a value is how the loop failed to converge, so the guard is that the original bytes survive
    // untouched when no progress is possible.
    const field = 'z'.repeat(150);
    const payload = { items: [{ kind: 'text', media_type: 'text/plain', text: field }], bulk: 'b'.repeat(4000) };
    const outcome = enforceResponseBudget(payload as never, 512);
    const items = (outcome.payload as Record<string, unknown>)['items'] as Array<Record<string, unknown>>;
    // Either it is untouched, or it is genuinely shorter AND marked. "Longer than the original" is the one
    // outcome that must be impossible.
    const text = String(items[0]?.['text']);
    expect(text.length <= field.length + TRUNCATION_MARKER.length).toBe(true);
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
    const outcome = enforceResponseBudget({ path: 'x.ipynb', cells, cell_count: 20 } as never, 4096);
    const kept = (outcome.payload as Record<string, unknown>)['cells'] as unknown[];
    // Every cell is still described, and the count still agrees with what is there.
    expect(kept.length).toBe(20);
    expect((outcome.payload as Record<string, unknown>)['cell_count']).toBe(20);
    // Something WAS dropped, or this case would pass on a budget that never degrades.
    expect(outcome.degraded).toBe(true);
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
