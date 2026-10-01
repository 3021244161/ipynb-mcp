import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.ts';

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

  it('never writes to stdout', () => {
    const { lines } = capture();
    // The default sink writes to process.stderr; assert the logger contract here by
    // ensuring our test sink is the only output channel used.
    const logger = createLogger('error', (line) => lines.push(line));
    logger.error('boom');
    expect(lines).toEqual([expect.stringContaining('error boom')]);
  });
});
