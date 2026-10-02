// stderr-only logger (D16/R14): stdout is reserved exclusively for JSON-RPC frames.
// Never log cell source or output contents (SPEC §5.10).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  readonly #level: LogLevel;
  // Injectable so tests can capture output without touching the real stderr.
  readonly #sink: (line: string) => void;

  constructor(level: LogLevel, sink: (line: string) => void = defaultSink) {
    this.#level = level;
    this.#sink = sink;
  }

  debug(message: string): void {
    this.#write('debug', message);
  }

  info(message: string): void {
    this.#write('info', message);
  }

  warn(message: string): void {
    this.#write('warn', message);
  }

  error(message: string): void {
    this.#write('error', message);
  }

  #write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) {
      return;
    }
    const timestamp = new Date().toISOString();
    this.#sink(`[ipynb-mcp] ${timestamp} ${level} ${message}`);
  }
}

function defaultSink(line: string): void {
  process.stderr.write(line + '\n');
}

export function createLogger(level: LogLevel, sink?: (line: string) => void): Logger {
  return new Logger(level, sink);
}
