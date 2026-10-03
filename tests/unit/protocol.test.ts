import { describe, expect, it } from 'vitest';

import {
  MAX_LINE_BYTES,
  NdjsonFramer,
  ProtocolFramingError,
  parseSidecarMessage,
} from '../../src/kernel/protocol.js';

describe('[step7][U22] NDJSON framing', () => {
  it('reassembles a response split across multiple chunks', () => {
    const framer = new NdjsonFramer();
    const line = JSON.stringify({ id: 'abc', ok: true, result: { status: 'ok' } });
    const buffer = Buffer.from(`${line}\n`, 'utf8');
    const lines: string[] = [];
    // Feed 7-byte chunks (no chunk boundary aligns with the newline).
    for (let offset = 0; offset < buffer.length; offset += 7) {
      lines.push(...framer.push(buffer.subarray(offset, Math.min(offset + 7, buffer.length))));
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(line);
    const message = parseSidecarMessage(lines[0]!);
    expect(message).toMatchObject({ id: 'abc', ok: true });
  });

  it('reassembles when fed byte-by-byte', () => {
    const framer = new NdjsonFramer();
    const line = '{"id":"x","ok":true,"result":{}}';
    const buffer = Buffer.from(`${line}\n`, 'utf8');
    const lines: string[] = [];
    for (const byte of buffer) {
      lines.push(...framer.push(Buffer.from([byte])));
    }
    expect(lines).toEqual([line]);
  });

  it('delivers multiple messages arriving in one chunk', () => {
    const framer = new NdjsonFramer();
    const chunk = Buffer.from('{"id":"1","ok":true,"result":{}}\n{"id":"2","ok":false,"error":{"code":"kernel_died","message":"x"}}\n');
    const lines = framer.push(chunk);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe('1');
    expect(JSON.parse(lines[1]!).id).toBe('2');
  });

  it('keeps a partial line buffered until the newline arrives', () => {
    const framer = new NdjsonFramer();
    expect(framer.push(Buffer.from('{"id":"1",'))).toEqual([]);
    expect(framer.push(Buffer.from('"ok":true,"result":{}}'))).toEqual([]);
    const lines = framer.push(Buffer.from('\n'));
    expect(lines).toEqual(['{"id":"1","ok":true,"result":{}}']);
  });

  it('tolerates CRLF line endings', () => {
    const framer = new NdjsonFramer();
    const lines = framer.push(Buffer.from('{"id":"1","ok":true,"result":{}}\r\n'));
    expect(lines).toEqual(['{"id":"1","ok":true,"result":{}}']);
  });

  it('rejects a single line above 64 MiB as a protocol error', () => {
    const framer = new NdjsonFramer();
    // Independent literal (review D5): asserting with the implementation's
    // own constant would pass even if the cap silently changed to 1 MiB.
    const cap = 64 * 1024 * 1024;
    expect(MAX_LINE_BYTES).toBe(cap); // guards accidental cap drift
    const huge = Buffer.alloc(cap + 1, 0x61);
    expect(() => framer.push(huge)).toThrow(ProtocolFramingError);
  });

  it('[D7] accepts a line of exactly 64 MiB (boundary)', () => {
    const framer = new NdjsonFramer();
    const cap = 64 * 1024 * 1024;
    const line = Buffer.alloc(cap, 0x61);
    // Exactly at the cap without a newline: still a legal unterminated line.
    expect(framer.push(line)).toEqual([]);
    expect(() => framer.push(Buffer.from('x'))).toThrow(ProtocolFramingError);
  });

  it('[A21/D5] many complete small lines totalling over 64 MiB in one chunk do NOT throw', () => {
    const framer = new NdjsonFramer();
    const smallLine = Buffer.from(`${'{"id":"1","ok":true,"result":{}}'.padEnd(1023, ' ')}
`);
    const reps = Math.ceil((64 * 1024 * 1024 + 1024) / smallLine.length);
    const big = Buffer.concat(Array(reps).fill(smallLine));
    const lines = framer.push(big);
    expect(lines).toHaveLength(reps);
  });

  it('[NEW-3][FRAME-1] one 64 MiB line in small chunks costs linear time, not quadratic', () => {
    // This case was worthless in its first version and the review proved it by
    // mutation (FRAME-1): it patched `indexOf` as an OWN property of a parent
    // Buffer and then fed the framer `parent.subarray(...)`, which does not
    // inherit own properties. The counter stayed 0, so `0 <= cap * 1.1` passed
    // for ANY implementation — including a quadratic one that took 36 s here.
    //
    // Three assertions now, and the MUTATION-CHECK notes say which one actually
    // has teeth:
    //   calls   — the guard on the guard: a counter that never runs cannot
    //             discriminate, so it must fail instead of passing silently.
    //   inspected — states the algorithmic intent (each byte scanned once).
    //   elapsed — the decisive one. Replacing `push` with a behaviour-identical
    //             quadratic version leaves `inspected` inside the bound (that
    //             implementation re-scans the growing prefix, which the first
    //             scan call already covered) and only the wall clock separates
    //             them: ~0.6 s here against 36 s for the quadratic shape, so the
    //             5 s ceiling has ~8x headroom on the slow side and ~700x on the
    //             fast one.
    const cap = 64 * 1024 * 1024;
    const chunkSize = 16 * 1024;
    const chunks = cap / chunkSize;
    const framer = new NdjsonFramer();
    const payload = Buffer.alloc(cap, 0x61);

    let inspected = 0;
    let calls = 0;
    const originalIndexOf = Buffer.prototype.indexOf;
    // `this` is annotated because the patched function is called as a method on
    // arbitrary Buffer instances, and noImplicitThis would otherwise reject it.
    Buffer.prototype.indexOf = function instrumented(
      this: Buffer,
      value: number,
      from?: number,
    ): number {
      // Count only this test's data, so unrelated Buffers cannot inflate it.
      if (this.buffer === payload.buffer) {
        calls += 1;
        inspected += this.length - (from ?? 0);
      }
      return originalIndexOf.call(this, value, from);
    };

    const startedAt = Date.now();
    try {
      for (let index = 0; index < chunks; index += 1) {
        framer.push(payload.subarray(index * chunkSize, (index + 1) * chunkSize));
      }
    } finally {
      Buffer.prototype.indexOf = originalIndexOf;
    }
    const elapsedMs = Date.now() - startedAt;

    expect(framer.pendingBytes).toBe(cap);
    expect(calls).toBeGreaterThan(0);
    // One pass over the payload: the whole point of the cursor.
    expect(inspected).toBeLessThanOrEqual(cap * 1.1);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('[FRAME-3] a rejected over-long line leaves the framer clean, not wedged', () => {
    const framer = new NdjsonFramer();
    // A complete line inside the cap followed by one that is not: the throw used
    // to leave the staging buffer holding the rejected bytes, so `pendingBytes`
    // lied and every later push threw again — the object was quietly single-use.
    const overLong = Buffer.alloc(MAX_LINE_BYTES + 16, 0x62);
    expect(() => framer.push(overLong)).toThrow(ProtocolFramingError);
    expect(framer.pendingBytes).toBe(0);
    // Usable again: the caller that catches the protocol error still owns a sane
    // object rather than a permanently poisoned one.
    expect(framer.push(Buffer.from('{"id":"1","ok":true}\n'))).toEqual(['{"id":"1","ok":true}']);
  });

  it('parseSidecarMessage returns null for garbage and non-objects', () => {
    expect(parseSidecarMessage('not json')).toBeNull();
    expect(parseSidecarMessage('42')).toBeNull();
    expect(parseSidecarMessage('null')).toBeNull();
    expect(parseSidecarMessage('{"event":"kernel_died","kernelId":"k"}')).toMatchObject({
      event: 'kernel_died',
      kernelId: 'k',
    });
  });
});
