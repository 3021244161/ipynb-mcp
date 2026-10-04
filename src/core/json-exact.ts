// Exact JSON (SPEC §5.4 row 7, §5.5.8-ish; review v9 V9-5, v10 V10-3/V10-6). Pure logic.
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
//     numeric literal that would not survive the trip through a JS number becomes a
//     marker object holding the literal text;
//   - `stringifyJsonExact` writes the literal back verbatim.
// Everything else is ordinary JSON, and a document this pair round-trips goes out
// byte-for-byte identical to `JSON.stringify`'s output.
//
// WHY IT IS NOT `JSON.rawJSON`: `JSON.rawJSON` only survives a `JSON.stringify` call
// that sees it directly. Our document is nested inside a payload that other layers
// stringify again (the tool result, the JSON-RPC frame), and Node's docs are explicit
// that mismatched literals are an error and that only the immediate object is
// consulted. A marker survives arbitrary nesting, is JSON-serializable itself, and
// needs no version-specific global.
//
// TWO ROUNDS OF "ONE GRID CELL SHORT" ARE WHAT MADE THIS FILE WHAT IT IS (v10):
//   - `losesPrecision` only recognized INTEGER literals, so every high-precision
//     DECIMAL was normalized the moment any write re-serialized the document — and
//     that write is usually an edit of a cell that had nothing to do with it (V10-3);
//   - the marker was a plain object property, so a file containing a similar-looking
//     object could forge it, and `readObject` assigned keys with `result[key] = …`,
//     which for `__proto__` runs a SETTER and silently drops the key from the user's
//     file (V10-6). `JSON.parse` gets that right; replacing it lost the cell.
// The matrix for both is `tests/unit/json-parser-semantics.test.ts` and
// `tests/unit/json-number-forms.test.ts`. Read them before changing anything here.

/**
 * Marker for a JSON number kept as text because a JS number would change it.
 *
 * A PLAIN, CLONEABLE OBJECT on purpose. `structuredClone` (which the edit path runs
 * on the document) drops non-enumerable and symbol-keyed properties and flattens
 * class instances to plain objects, so a `class` + `instanceof` marker or a `Symbol`
 * key would stop being recognized after a clone — and the fallback for an
 * unrecognized marker is to write the marker object into the user's file. A plain
 * object survives, so identity is re-established by shape instead.
 */
export interface ExactNumber {
  readonly __ipynb_exact_number__: string;
}

/**
 * Is this value a marker {@link exactNumber} produced?
 *
 * The check is two-sided, because either side alone leaves a hole:
 *   - SHAPE: exactly one own key, named `__ipynb_exact_number__`, holding a JSON number.
 *     A file may legally contain such an object, and mistaking it for a marker would
 *     write a bare number where the file had a structure — so shape alone is not enough
 *     (the review's forged `{"__ipynb_exact_number__":"42"}` passed the first version);
 *   - FROZEN: {@link exactNumber} freezes what it builds, and `JSON.parse`-style parsing
 *     (ours included) always produces extensible objects. A value that came from a file
 *     is therefore never frozen, and a real marker always is.
 *
 * Frozen rather than a `class`/`Symbol` for a reason that is not obvious: the edit path
 * runs `structuredClone` over the document, and `structuredClone` flattens class
 * instances to plain objects and DROPS symbol-keyed and non-enumerable properties. A
 * marker that stops being recognized after a clone would be written into the user's file
 * AS AN OBJECT — a silent rewrite of the same family this module exists to prevent.
 * Extensibility IS preserved by `structuredClone`, so the marker survives the clone and
 * the identity is re-established after it.
 */
export function isExactNumber(value: unknown): value is ExactNumber {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (Object.isExtensible(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== '__ipynb_exact_number__') {
    return false;
  }
  const literal = (value as { __ipynb_exact_number__: unknown }).__ipynb_exact_number__;
  return typeof literal === 'string' && JSON_NUMBER.test(literal);
}

/** Wrap a JSON number literal so it survives stringification untouched. */
export function exactNumber(literal: string): ExactNumber {
  return Object.freeze({ __ipynb_exact_number__: literal });
}

/**
 * Would `Number(literal)` followed by `String()` give the literal back?
 *
 * This is the exact round-trip condition, and it is what the WRITE side depends on:
 * a literal that survives it produces the same bytes through a plain number, so it
 * does not need a marker.
 */
function survivesAsNumber(literal: string): boolean {
  const value = Number(literal);
  return Number.isFinite(value) && String(value) === literal;
}

/**
 * Would keeping this literal as a JS number change what is written back?
 *
 * The judgement is NOT "is this an imprecise integer" any more — that rule protected
 * the one shape it was written for and let every other shape through (v10 V10-3).
 * The question is the one that matters: `String(Number(literal)) === literal`? If
 * yes, a plain number round-trips byte-identically and needs nothing; if no, the
 * literal is the only representation that survives, whatever its form.
 *
 * Consequences, all of them intended and each covered by a case:
 *   - `18446744073709551616` → rounds → protected (v9's fix, kept);
 *   - `0.1234567890123456789012345` → shortens → protected (v10's fix);
 *   - `1.0000000000000001` → `1` → protected (v10's fix);
 *   - `1E+2` → `100`, `1e21` → `1e+21`, `-0` → `0` → protected: not precision loss,
 *     but the write-back would still not be the file's bytes, and "logically equal,
 *     silently rewritten" is the thing this project refuses to do;
 *   - `1e400` → `Infinity` → protected;
 *   - `0.1` and `1.5` survive the round trip and stay plain numbers, which keeps the
 *     common case cheap and the response free of markers.
 */
export function losesPrecision(literal: string): boolean {
  return !survivesAsNumber(literal);
}

/**
 * The JSON number grammar, which is NOT JavaScript's.
 *
 * The first version scanned digits and accepted whatever came out, so `01` parsed as
 * `1` where `JSON.parse` throws ("Unexpected number in JSON at position 1"). A parser
 * that accepts more than the format does is a parser whose output the authority
 * (nbformat → Python `json`) may reject, so the grammar is checked explicitly rather
 * than approximated.
 */
export const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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
      // DEFINE the property, never assign it. `result[key] = value` runs
      // `Object.prototype`'s `__proto__` SETTER for that one key, so the key is not
      // stored at all: it disappears from the response AND from every later write,
      // which is how v10-6 deleted data from users' files. `defineProperty` creates an
      // ordinary own data property like `JSON.parse` does, and it is also what keeps a
      // later assignment to `__proto__` from being possible here at all.
      //
      // Order matters for the same reason the writer's `Object.entries` does: a
      // duplicate key must overwrite the FIRST position's value, which is what
      // `defineProperty` on an existing key does (a delete+define would move it to the
      // end and change the byte order of the file).
      Object.defineProperty(result, key, {
        value: this.readValue(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
    // The grammar, not just "we consumed some characters": `01`, `1.`, `.1`, `+1` and
    // `- 1` all parse as something under a loose scanner while `JSON.parse` rejects
    // them, and accepting more than the format allows means we can write back bytes the
    // authority would refuse.
    if (!JSON_NUMBER.test(literal)) {
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
      // `-0` first: `String(-0)` is `'0'`, which would drop the sign. JSON itself has
      // no negative zero, so `JSON.stringify(-0)` writes `0` too — but this serializer
      // exists to keep the document's bytes and the document may hold what our own
      // parser read from `-0`. Sign preservation is deliberate and covered by a case.
      if (Object.is(value, -0)) {
        return '-0';
      }
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
