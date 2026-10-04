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
 *   - NOT EXTENSIBLE: {@link exactNumber} freezes what it builds, and parsing (ours
 *     included) always produces extensible objects, so a value that came from a file is
 *     never frozen. This is the half that makes forgery impossible.
 *
 * WHY FREEZING, given the cost below — the alternative was tried and does not work:
 * a `class` + `instanceof` marker or a `Symbol`-keyed one would be invisible to a file
 * (a file cannot produce a class instance or a symbol key), but `structuredClone` DROPS
 * symbol-keyed and non-enumerable properties and flattens class instances to plain
 * objects. A marker that stops being recognized is then written into the user's file AS
 * AN OBJECT — the silent rewrite this module exists to prevent.
 *
 * THE LIMIT OF THIS DESIGN, stated plainly because the first version of this comment
 * claimed the opposite (review v11 V11-2): **`structuredClone` discards extensibility, so
 * cloning ANY document invalidates every marker in it.** Measured, not assumed:
 *
 *     const cloned = structuredClone(exactNumber('18446744073709551616'));
 *     isExactNumber(cloned)   // false
 *     Object.isExtensible(cloned)  // true
 *     stringifyJsonExact({ v: cloned })
 *       // {"v":{"__ipynb_exact_number__":"18446744073709551616"}} — the marker object
 *
 * That is a known limitation, not an invariant, and it is why the SERIALIZATION PATH MUST
 * USE THE ORIGINAL PARSE TREE and never a clone of it. Today it does: `structuredClone` is
 * only used for the `originalDoc` / `preRunDoc` snapshots that feed comparisons
 * (`src/mcp/tools/edit.ts`, `src/run.ts`), never for a document that is written back. A
 * refactor that snapshots-then-writes would silently write marker objects into user files,
 * so the assumption is pinned by an assertion in `tests/unit/json-exact.test.ts` rather
 * than left in a comment (AGENTS §9: turn assumptions into measurements).
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
 * A marker flattened back to the number it stands for, for a MODEL-VISIBLE field, or null
 * when the value is not a marker.
 *
 * The projection in `outputs.ts` covers `application/json` values; a document FIELD like
 * `execution_count` reaches the response by a different route (`render/read.ts` copies it
 * straight through), so it needs the same treatment or the marker object is published as if
 * it were the file's content — a structure that exists nowhere, documented nowhere, and
 * forbidden by this module's own invariant (review v11 V11-6).
 */
export function plainNumber(value: unknown): number | null {
  return isExactNumber(value) ? Number(value.__ipynb_exact_number__) : null;
}

/**
 * Does keeping this literal as a JS number change the number's VALUE?
 *
 * The v10 answer asked `String(Number(literal)) === literal`, which is the BYTES question
 * and silently conflated with the value question. `100.0`, `2.0`, `1e2`, `0.10`,
 * `1.5e-07` and `2.5e-05` are all spelled differently from `String(Number(…))` while
 * denoting EXACTLY the value the file holds, and Python's own `json.dumps` writes floats
 * that way — so every notebook with a float in it was told "this value was not
 * representable exactly" about a value that was (review v11 V11-1). Two consequences,
 * both bad: the model repeats a false statement, and the real warnings (`2**64`,
 * `1e400`) drown in the noise.
 *
 * The criterion is now the VALUE, and it is answered by comparing DIGITS: the literal
 * against the double's own shortest round-trip spelling, with the formatting a JSON
 * writer may change normalized away (see {@link spellingsAgree}, which also records why
 * the more rigorous-looking exact-rational comparison this replaced was wrong in both
 * directions).
 *
 * What survives as a plain number: the value is the file's value, so the model is not
 * misled. What changes is the spelling (`100.0` → `100`, `1E+2` → `100`), and that is the
 * fidelity promise the project actually makes — "logically unchanged", not "byte-minimal
 * diff" (SPEC §5.5.7). Bytes still win wherever the digits would change.
 */
export function losesPrecision(literal: string): boolean {
  return losesInformation(literal);
}

/**
 * Would replacing this literal with the double change what it conveys?
 *
 * The double's shortest round-trip spelling (`String(Number(literal))`) is the reference: a
 * canonical form that denotes the same number. The literal is compared with it by normalizing
 * both to the same shape, and only a real difference counts — which is why
 * `0.1000000000000000055511151231257827021181583404541015625` is accepted (its digits are the
 * double named by `0.1`, and the short form says the same thing in three characters).
 *
 * ZERO IS THE EDGE THAT NEEDS ITS OWN HANDLING, and the v11 version of this function got it
 * wrong in the worst available way (review v12 V12-1). It read:
 *
 *     if (value === 0) return isNegativeZero(literal);
 *
 * which is right about `-0` and catastrophically wrong about UNDERFLOW: `1e-400`, `1e-330`,
 * `1e-324` and `2e-400` all become the double zero while denoting a nonzero number, so the
 * early return called them "no information lost" and the next write replaced them with `0` —
 * a silent change of the value, on disk, triggered by editing an unrelated cell. That is the
 * exact failure this module exists to prevent, and the v10 rule it replaced had protected these
 * literals. The negative half was just as bad in a different way: `-1e-400` kept its digits but
 * was reported as "negative zero … the value is exact", two false statements per sentence.
 *
 * So zero is now split into the three cases it actually has:
 *
 *   - `-0`: exactly zero, sign not carried by a JSON response → reported, digits kept (`-0`);
 *   - a literal whose MANTISSA is zero (`0`, `0.0`, `0e0`, `0e-5`, `0.0e-400`): it denotes zero
 *     and the double holds it. Nothing is lost, and normalizing `0e-5` to `0` is the same
 *     no-information rewrite as `100.0` → `100` — NOT an underflow, which is why the check is
 *     about the mantissa's digits and not about `/[1-9]/` matching a digit in the exponent;
 *   - a literal with a nonzero mantissa that evaluates to zero (`1e-400`): UNDERFLOW. The
 *     value changes, so the literal stays and the model is told, which also makes this case
 *     symmetric with overflow (`1e400` → null + warning), as D-056's first invariant requires.
 */
function losesInformation(literal: string): boolean {
  const value = Number(literal);
  if (!Number.isFinite(value)) {
    return true;
  }
  if (value === 0) {
    return isNegativeZero(literal) || denotationIsNonzero(literal);
  }
  return !insignificantFormatting(literal);
}

/**
 * Does this literal denote a nonzero number, even though a double cannot hold it?
 *
 * Only the mantissa matters: `1e-400` denotes 10⁻⁴⁰⁰ and underflows, while `0e-400` denotes
 * zero and merely changes spelling. Testing the whole literal for a nonzero digit would call
 * the second one an underflow, because its EXPONENT has digits in it.
 */
export function denotationIsNonzero(literal: string): boolean {
  const match = /^-?(\d*)(?:\.(\d*))?/.exec(literal);
  const mantissa = `${match?.[1] ?? ''}${match?.[2] ?? ''}`;
  return /[1-9]/.test(mantissa);
}

/**
 * Does this literal write the value the way a JSON writer would, modulo the formatting
 * that carries no information?
 *
 * This is the question, stated positively. Getting here took three versions, and the two
 * wrong ones are recorded because both look more rigorous than this one:
 *
 *   - "is the double's exact value equal to the literal's exact value": `2**64`
 *     (`18446744073709551616`) satisfies it — the double IS that integer — and writing
 *     that number produces `18446744073709552000`, the true value with different DIGITS,
 *     which is the silent rewrite this module exists to prevent. Meanwhile `0.1` FAILS it
 *     (the double is not the rational 1/10), so the ordinary float in every notebook was
 *     reported as unrepresentable;
 *   - "are the digit sequences equal": symmetric but blind in the other direction, and it
 *     cannot be the rule either (see the `warned` table for what each literal does).
 *
 * What the review actually specified (and it is the one rule that gets every measured case
 * right) is narrower and simpler: normalize away the spellings that carry NO information,
 * then ask whether what is left is the double's own shortest round-trip form. The
 * differences that carry no information are exactly these:
 *
 *   - a `+` on the exponent, and leading zeros in it (`1e+100` → `1e100`, `e-07` → `e-7`);
 *   - a trailing `.0` or trailing zeros in the fraction (`100.0` → `100`, `0.10` → `0.1`,
 *     `2.0` → `2`);
 *   - exponent notation for a magnitude `String()` prints in full (`1e2` → `100`,
 *     `1.5e3` → `1500`), and the reverse — `1e21` is compared as `1e21` against the
 *     `String()` form `1e+21`, so it does NOT match and keeps its marker (v12 V12-2 caught
 *     the v11 note here claiming the opposite).
 *
 * The corrections this comment needed are themselves the evidence for the rule that a
 * documented example must be run: the 55-digit case is REPORTED (it is a different spelling
 * of `0.1` and the table says `warned: true`), not "accepted" as the v11 note said, and
 * `0.10000000000000001` is reported because the double it names is not `Number('0.1')`.
 *
 * After normalization the comparison is with `String(Number(literal))` — the double's
 * shortest form — so the cases that must still be reported fall out for free:
 * `2**64` → `18446744073709551616` vs `18446744073709552000` (digits differ),
 * `1e21` → `1e21` vs `1e+21` (the exponent's sign is the only difference, and `String()`
 * does print it), `1.0000000000000001` → itself vs `1` (the value differs),
 * `1e400` → handled before this by the finiteness test.
 *
 * The consequence to accept, and it is the review's own recommendation: `1E+2` and
 * `100.0` are written back as `100`. The VALUE is identical and the file stays valid
 * JSON, which is the fidelity promise the project makes — "logically unchanged", not
 * "byte-minimal diff" (SPEC §5.5.7). Bytes still win wherever a digit would change.
 */
function insignificantFormatting(literal: string): boolean {
  return normalizedSpelling(literal) === String(Number(literal));
}

/**
 * The literal's digits and magnitude with the no-information formatting removed.
 *
 * Written as string arithmetic rather than the obvious `Number(literal).toString()`,
 * because the two questions are different and this one must not lose the very digits it is
 * comparing: `Number('123456789012345678901234567890')` has already rounded those away, and
 * a normalizer built on it would call that literal exact.
 *
 * The state is a COEFFICIENT (the digits, with leading and trailing zeros removed) and the
 * POWER OF TEN it is multiplied by. Every structural edit moves both, and every one of the
 * four below was got wrong at least once while this function was being written — which is
 * why `json-number-forms.test.ts` pins the normalizer itself against a written table rather
 * than only checking the values that flow through it:
 *   - the integer part's SIGNIFICANT length sets the initial power (`0.1` counts zero
 *     integer digits, not one: the leading `0` is not a digit of the number);
 *   - a negative exponent lowers it by that many, a positive one raises it;
 *   - dropping a LEADING zero (`.5` → `5`) lowers it by one, because the coefficient now
 *     starts one place later;
 *   - dropping a TRAILING zero (`100.0` → `1`) raises it by one per zero, because the
 *     coefficient ends one place earlier — the term whose absence turned `100.0` into
 *     `0.1`.
 *
 * Rendering then follows `String()`: exponent notation above 10^21 and below 10^-6, and a
 * plain decimal in between, with the exponent's sign printed (`1e+21`, `1e-7`).
 */
export function normalizedSpelling(literal: string): string {
  const match = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (match === null) {
    return literal;
  }
  const sign = match[1] === '-' ? '-' : '';
  const integerPart = match[2] ?? '';
  const fraction = match[3] ?? '';
  const explicit = Number(match[4] ?? '0');
  // ONE quantity, defined once: how many places the decimal point sits to the RIGHT of the
  // start of the literal's digits, after the exponent is applied.
  //
  // This function took four attempts, and the first three all failed by tracking the point
  // in more than one place — "the integer part's length" here, "the coefficient's length"
  // there, "the removed zeros" somewhere else. Each version then had to be corrected with a
  // term that was wrong in a different input. With a single `point`, every edit to the digit
  // string moves exactly that number, and the arithmetic is visible:
  //   - dropping a LEADING zero shortens the string on the left, so the point moves left;
  //   - dropping a TRAILING zero shortens it on the right, so the point moves right
  //     (`100.0` → coefficient `1`, point 3 → 1 × 10^3 = 100).
  let digits = `${integerPart}${fraction}`;
  let point = integerPart.length + explicit;
  const leading = leadingZeros(digits);
  digits = digits.slice(leading);
  point -= leading;
  // Trimming the right end does NOT move the point: the point counts digits from the left,
  // and the value is `digits × 10^(point − digits.length)`. Dropping that trailing zero is
  // exactly what keeps `100.0` equal to `100 × 10^(3 − 3)`.
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  if (digits === '') {
    // Zero, which `String()` prints without a sign. (`-0` is decided before this function
    // is reached, so the sign cannot be lost here by accident.)
    return '0';
  }
  // `point` is now the number of digits to the left of the decimal point, and the value is
  // `digits × 10^(point − digits.length)`. The rendering below matches `String()`'s choice
  // of notation. The "very small" side keys on the POINT, not on the coefficient's length:
  // `0.1` has point 0 and is printed in full, while the 55-digit spelling of the same double
  // also has point 0 and is printed as `1.0000…e-55`, which is what `String()` does with a
  // coefficient that long.
  if (point > 21 || point <= -6) {
    const head = digits.slice(0, 1);
    const tail = digits.slice(1);
    const exponent = point - 1;
    return `${sign}${head}${tail === '' ? '' : `.${tail}`}e${exponent >= 0 ? '+' : ''}${String(exponent)}`;
  }
  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** How many leading zeros a digit string has (the whole string when it is all zeros). */
function leadingZeros(digits: string): number {
  return /^0+/.exec(digits)?.[0].length ?? 0;
}

/** `-0`: exactly zero, but the sign is a fact the response cannot carry. */
export function isNegativeZero(literal: string): boolean {
  return literal.startsWith('-') && Number(literal) === 0;
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

/**
 * The nesting depth this reader accepts, as a limit rather than a stack overflow.
 *
 * A notebook's own shape is about seven levels; 512 leaves room for metadata a future format
 * adds and still fails long before the JavaScript stack does. Exported so the test can assert
 * the boundary from both sides and `parse.ts` can say something accurate when it is hit.
 */
export const MAX_JSON_DEPTH = 512;

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
    // A recursive-descent reader has a stack, so a deeply nested document can exhaust it and
    // surface as `RangeError: Maximum call stack size exceeded`. That is what a 12 000-deep
    // array did (review v11 V11-8②): the tool reported `parse_failed` / "notebook file is not
    // valid JSON" about a document `JSON.parse` accepts — a false statement, and one that
    // makes a legal file permanently unreadable.
    //
    // 512 frames is far past anything a notebook holds (the shape is fixed: notebook → cells →
    // cell → outputs → output → data → value), and it is a LIMIT rather than a crash, so the
    // message can say what is actually wrong.
    if (this.depth >= MAX_JSON_DEPTH) {
      throw new SyntaxError(`JSON nesting is deeper than ${String(MAX_JSON_DEPTH)} levels`);
    }
    this.depth += 1;
    try {
      return this.readValueInner();
    } finally {
      this.depth -= 1;
    }
  }

  private readValueInner(): unknown {
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

  private depth = 0;

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
        // RFC 8259: an unescaped control character is not allowed in a string, and both
        // authorities agree — `JSON.parse` says "Bad control character in string literal",
        // Python's `json.loads` says "Invalid control character". Accepting them was worse
        // than lenient: the next write ESCAPES the character, so an invalid file became
        // valid and the user's bytes changed, silently (review v11 V11-8①).
        if (char.charCodeAt(0) < 0x20) {
          throw new SyntaxError('Bad control character in string literal in JSON');
        }
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
        // Indexed rather than `map` + `join`, which turns a hole into an empty string and an
        // empty string into invalid JSON (review v11 V11-8③; see `writePretty`).
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const entry: unknown = value[index];
          items.push(writeCompact(entry === undefined ? null : entry));
        }
        return `[${items.join(',')}]`;
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
    // Indexed, not `map`: `map` SKIPS holes, and `join` then renders them as nothing, so
    // `[1,,3]` came out as the invalid JSON `[1,,3]` where `JSON.stringify` writes
    // `[1,null,3]` (review v11 V11-8③). Not reachable through the parser, which never
    // creates a hole — but this is a public serializer, and "my serializer can emit bytes the
    // authority rejects" is not a property to leave lying around.
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index];
      entries.push(`${inner}${writePretty(entry === undefined ? null : entry, pad, depth + 1, '')}`);
    }
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
