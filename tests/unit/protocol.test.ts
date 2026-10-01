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
    const huge = Buffer.alloc(MAX_LINE_BYTES + 1, 0x61); // 'a' * 64MiB+1
    expect(() => framer.push(huge)).toThrow(ProtocolFramingError);
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
