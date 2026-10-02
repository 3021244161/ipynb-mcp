import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.js';

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('[step1] Logger (stderr-only, D16/R14)', () => {
  it('writes enabled levels and suppresses levels below the threshold', () => {
    const { lines, sink } = capture();
    const logger = createLogger('warn', sink);
    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown-warn');
    logger.error('shown-error');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('warn shown-warn');
    expect(lines[1]).toContain('error shown-error');
  });

  it('emits everything at debug level with the [ipynb-mcp] prefix and ISO timestamp', () => {
    const { lines, sink } = capture();
    const logger = createLogger('debug', sink);
    logger.debug('d');
    logger.info('i');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[ipynb-mcp\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z debug d$/);
  });

  it('never writes to stdout: the DEFAULT sink targets stderr, not stdout', () => {
    // Review D5: the old version asserted nothing about stdout and never ran
    // the default sink. Capture-only interception (no call-through: a bare
    // function call loses the stream `this` and throws on _writableState),
    // restore in finally, then assert which stream received the bytes.
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const logger = createLogger('error');
      logger.error('default-sink-check');
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    expect(stdoutChunks).toEqual([]);
    expect(stderrChunks.join('')).toContain('default-sink-check');
  });
});
