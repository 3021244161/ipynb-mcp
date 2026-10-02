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
