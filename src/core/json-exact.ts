// Exact JSON (SPEC §5.4 row 7, §5.5.8-ish; review v9 V9-5). Pure logic.
//
// `JSON.parse` turns every JSON number into an IEEE-754 double, so a notebook that
// stores `18446744073709551616` in an `application/json` output comes back as
// `18446744073709552000` — silently, with `warnings: []`, and the run path then
// writes the rounded value back to disk. That is the same failure family as v7/v8's
// json-string bug (a value the file does not contain reaching the model), one order
// of magnitude worse because the file itself changes.
//
// This module keeps such a number as its ORIGINAL LITERAL:
//   - `parseJsonExact` builds the same tree `JSON.parse` would, except that a
//     numeric literal JavaScript cannot represent exactly becomes a marker object
//     holding the literal text;
//   - `stringifyJsonExact` writes the literal back verbatim.
// Everything else is ordinary JSON, and a document with no such number round-trips
// through this pair byte-for-byte identically to `JSON.parse`/`JSON.stringify`.
//
// Why a marker object instead of `JSON.rawJSON`: `JSON.rawJSON` only survives a
// `JSON.stringify` call that sees it directly. Our document is nested inside a
// payload that other layers stringify again (the tool result, the JSON-RPC frame),
// and Node's docs are explicit that mismatched literals are an error and that only
// the immediate object is consulted. A marker survives arbitrary nesting, is
// JSON-serializable itself, and needs no version-specific global.

/** Marker for a JSON number kept as text because JS would round it. */
export interface ExactNumber {
  readonly __ipynb_exact_number__: string;
}

/** Is this value the marker {@link exactNumber} produces? */
export function isExactNumber(value: unknown): value is ExactNumber {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { __ipynb_exact_number__?: unknown }).__ipynb_exact_number__ === 'string'
  );
}

/** Wrap a JSON number literal so it survives stringification untouched. */
export function exactNumber(literal: string): ExactNumber {
  return { __ipynb_exact_number__: literal };
}

/**
 * Would `Number(literal)` lose information?
 *
 * The test is deliberately narrow — "not a safe integer" — because those are the
 * only literals this project can prove it would change. A huge EXPONENT
 * (`1e400` → `Infinity`) and a long fraction (`0.1234567890123456789`) round too,
 * but the rounded value is a different REPRESENTATION of the same mathematical
 * value rather than a different integer, and treating every non-canonical number
 * as unrepresentable would rewrite documents nobody is complaining about.
 * `Number.isSafeInteger` is exactly the "this integer is preserved" contract.
 */
export function losesPrecision(literal: string): boolean {
  const value = Number(literal);
  if (!Number.isFinite(value)) {
    return true;
  }
  // `Number.isSafeInteger` is false for a non-integer like `1.5`, and 1.5 needs no
  // protection, so the literal must also look like an integer to qualify.
  return /^-?\d+$/.test(literal) && !Number.isSafeInteger(value);
}

// ---------------------------------------------------------------------------
// Parser: a straightforward recursive-descent JSON reader. It exists rather than a
// `JSON.parse` reviver because a reviver is handed the already-parsed Number: the
// literal is gone by then, and no amount of post-processing recovers it.
// ---------------------------------------------------------------------------

export function parseJsonExact(text: string): unknown {
  const reader = new Reader(text);
  const value = reader.readValue();
  reader.skipWhitespace();
  if (!reader.atEnd()) {
    throw new SyntaxError('Unexpected non-whitespace character after JSON');
  }
  return value;
}

class Reader {
  private index = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd()) {
      const code = this.text.charCodeAt(this.index);
      // space, tab, LF, CR — the only four JSON allows.
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  readValue(): unknown {
    this.skipWhitespace();
    const char = this.text[this.index];
    switch (char) {
      case '{':
        return this.readObject();
      case '[':
        return this.readArray();
      case '"':
        return this.readString();
      case 't':
        return this.readLiteral('true', true);
      case 'f':
        return this.readLiteral('false', false);
      case 'n':
        return this.readLiteral('null', null);
      default:
        return this.readNumber();
    }
  }

  private readObject(): Record<string, unknown> {
    this.index += 1; // {
    const result: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') {
        throw new SyntaxError('Expected property name or \'}\' in JSON');
      }
      const key = this.readString();
      this.skipWhitespace();
      if (this.text[this.index] !== ':') {
        throw new SyntaxError("Expected ':' after a property name in JSON");
      }
      this.index += 1;
      result[key] = this.readValue();
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ',') {
        this.index += 1;
        continue;
      }
      if (separator === '}') {
        this.index += 1;
        return result;
      }
      throw new SyntaxError("Expected ',' or '}' in JSON");
    }
  }

  private readArray(): unknown[] {
    this.index += 1; // [
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.readValue());
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ',') {
        this.index += 1;
        continue;
      }
      if (separator === ']') {
        this.index += 1;
        return result;
      }
      throw new SyntaxError("Expected ',' or ']' in JSON");
    }
  }

  private readString(): string {
    this.index += 1; // opening quote
    let result = '';
    for (;;) {
      if (this.atEnd()) {
        throw new SyntaxError('Unterminated string in JSON');
      }
      const char = this.text[this.index]!;
      this.index += 1;
      if (char === '"') {
        return result;
      }
      if (char !== '\\') {
        result += char;
        continue;
      }
      const escape = this.text[this.index]!;
      this.index += 1;
      switch (escape) {
        case '"':
          result += '"';
          break;
        case '\\':
          result += '\\';
          break;
        case '/':
          result += '/';
          break;
        case 'b':
          result += '\b';
          break;
        case 'f':
          result += '\f';
          break;
        case 'n':
          result += '\n';
          break;
        case 'r':
          result += '\r';
          break;
        case 't':
          result += '\t';
          break;
        case 'u': {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new SyntaxError('Invalid \\u escape in JSON');
          }
          this.index += 4;
          result += String.fromCharCode(Number.parseInt(hex, 16));
          break;
        }
        default:
          throw new SyntaxError(`Invalid escape in JSON: \\${escape}`);
      }
    }
  }

  private readLiteral<T>(word: string, value: T): T {
    if (this.text.slice(this.index, this.index + word.length) !== word) {
      throw new SyntaxError(`Unexpected token in JSON: ${this.text.slice(this.index, this.index + 8)}`);
    }
    this.index += word.length;
    return value;
  }

  private readNumber(): unknown {
    const start = this.index;
    if (this.text[this.index] === '-') {
      this.index += 1;
    }
    while (/[0-9]/.test(this.text[this.index] ?? '')) {
      this.index += 1;
    }
    if (this.text[this.index] === '.') {
      this.index += 1;
      while (/[0-9]/.test(this.text[this.index] ?? '')) {
        this.index += 1;
      }
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') {
        this.index += 1;
      }
      while (/[0-9]/.test(this.text[this.index] ?? '')) {
        this.index += 1;
      }
    }
    const literal = this.text.slice(start, this.index);
    if (literal === '' || literal === '-') {
      throw new SyntaxError(`Unexpected token in JSON: ${this.text.slice(start, start + 8)}`);
    }
    return losesPrecision(literal) ? exactNumber(literal) : Number(literal);
  }
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify(value, null, indent)` with two deviations, both required by the
 * round-trip promise:
 *   - a marker is written as its literal, so the number survives;
 *   - the output is built by hand instead of by `JSON.stringify`, because the
 *     built-in cannot be told about markers nested inside arrays and objects.
 * Key order, escaping and indentation follow the built-in's observable behaviour
 * for the values this project stores.
 */
export function stringifyJsonExact(value: unknown, indent?: number | string): string {
  // `undefined` is compact, and so is a zero-length pad — but `'\t'` is NOT. The
  // first version asked "did the pad come out empty?", which turned a tab-indented
  // document into a single line: a formatting change on every write for any caller
  // that indents with tabs.
  const pad = normalizeIndent(indent);
  return indent === undefined || pad === '' ? writeCompact(value) : writePretty(value, pad, 0, '');
}

function normalizeIndent(indent: number | string | undefined): string {
  if (indent === undefined) {
    return '';
  }
  if (typeof indent === 'number') {
    return ' '.repeat(Math.max(0, Math.min(10, Math.floor(indent))));
  }
  return indent.slice(0, 10);
}

function writeCompact(value: unknown): string {
  if (isExactNumber(value)) {
    return value.__ipynb_exact_number__;
  }
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // Matches the built-in: NaN/Infinity become null.
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => writeCompact(entry === undefined ? null : entry)).join(',')}]`;
      }
      const parts: string[] = [];
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === undefined) {
          continue;
        }
        parts.push(`${JSON.stringify(key)}:${writeCompact(entry)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      // undefined / function / symbol have no JSON form. The built-in omits them
      // from objects (handled above) and writes null inside arrays.
      return 'null';
  }
}

function writePretty(value: unknown, pad: string, depth: number, prefix: string): string {
  if (isExactNumber(value)) {
    return `${prefix}${value.__ipynb_exact_number__}`;
  }
  if (value === null || typeof value !== 'object') {
    return `${prefix}${writeCompact(value)}`;
  }
  const inner = pad.repeat(depth + 1);
  const closing = pad.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${prefix}[]`;
    }
    const entries = value.map(
      (entry) => `${inner}${writePretty(entry === undefined ? null : entry, pad, depth + 1, '')}`,
    );
    return `${prefix}[\n${entries.join(',\n')}\n${closing}]`;
  }
  const entries: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) {
      continue;
    }
    entries.push(`${inner}${JSON.stringify(key)}: ${writePretty(entry, pad, depth + 1, '')}`);
  }
  if (entries.length === 0) {
    return `${prefix}{}`;
  }
  return `${prefix}{\n${entries.join(',\n')}\n${closing}}`;
}
