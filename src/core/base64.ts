// Base64 codec (SPEC §4.4). Pure: no `node:*`, no Buffer, no DOM — the modules
// that need it (`core/outputs`) are forbidden from reaching for either, and the
// decode side has to agree with `atob`, which is the SDK's own image validator.
//
// Why this is its own module rather than helpers inside `outputs.ts`: the image
// block path and the artifact path must produce the SAME string from the same
// document value. Two implementations is exactly how v9's `-32602` happened —
// one layer stripped the `data:` prefix, the other handed the raw value to the
// SDK, and the model lost the whole notebook over one image (review v9 V9-1).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const VALUES = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Does this decode as base64 — i.e. would `atob` accept it?
 *
 * `atob` is the authority, because the MCP SDK validates `ImageContent.data` with
 * it and a rejection is a protocol error for the entire call. That sets two of the
 * rules here, and one of them is easy to get wrong:
 *   - padding is OPTIONAL for `atob` (it re-pads internally), so `'QQ'` is valid
 *     input even though it is not the canonical form we emit;
 *   - a length of 1 mod 4 cannot be re-padded at all, so `'A'`, `'AAAAA'` and
 *     `'QUIAB'` are invalid, while `'AB=='` is ACCEPTED (the ignored bits are not
 *     checked by `atob` either — being stricter than the boundary that actually
 *     rejects us buys nothing and would withhold images clients can read).
 */
export function isBase64Shaped(value: string): boolean {
  if (value.length % 4 === 1) {
    return false;
  }
  let padding = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x3d /* = */) {
      padding += 1;
      continue;
    }
    if (padding > 0 || code >= 128 || VALUES[code] === -1) {
      return false;
    }
  }
  // `atob` rejects more than two pad characters outright, and a pad count that
  // does not complete the final group is rejected too (`'QQ='`): re-padding such a
  // value would silently change the bytes, so it is not base64.
  const dataChars = value.length - padding;
  return padding <= 2 && (padding === 0 || value.length % 4 === 0) && dataChars % 4 !== 1;
}

/** Base64 of bytes with `=` padding — the form `atob` and every client expects. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const chunk = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += ALPHABET[(chunk >> 18) & 0x3f];
    out += ALPHABET[(chunk >> 12) & 0x3f];
    out += b1 === undefined ? '=' : ALPHABET[(chunk >> 6) & 0x3f];
    out += b2 === undefined ? '=' : ALPHABET[chunk & 0x3f];
  }
  return out;
}

/**
 * Bytes for a base64 string, or null when it is not base64.
 *
 * Padding is OPTIONAL on input — `atob` re-pads internally and clients accept
 * what `atob` accepts — so the decoded length is derived from the DATA characters
 * and never from the pad characters. Deriving it from the input's own padding
 * decodes `'QQ'` to zero bytes, which is how a payload can silently become an
 * empty image.
 *
 * Deliberately returns null instead of throwing: every caller has a documented
 * degradation (`image_materialize_failed` + a zero-byte image) and needs to say
 * WHY, which an exception cannot carry.
 */
export function decodeBase64ToBytes(value: string): Uint8Array | null {
  if (!isBase64Shaped(value)) {
    return null;
  }
  const dataChars = value.endsWith('==') ? value.length - 2 : value.endsWith('=') ? value.length - 1 : value.length;
  const tail = dataChars % 4;
  const byteLength = ((dataChars - tail) / 4) * 3 + (tail === 0 ? 0 : tail - 1);
  const bytes = new Uint8Array(byteLength);
  // Base64 is a bitstream, not a sequence of independent groups: the final group
  // contributes only as many bits as the byte count needs, and the bits it does
  // contribute are its HIGH ones. The first version placed the characters at fixed
  // bit offsets and dropped the tail character, which decoded `'Aic='` to
  // `[0x02, 0x20]` instead of `[0x02, 0x27]` — a wrong image, silently.
  let bitBuffer = 0;
  let bitCount = 0;
  let out = 0;
  for (let i = 0; i < dataChars; i += 1) {
    const code = value.charCodeAt(i);
    const six = code >= 128 ? -1 : (VALUES[code] ?? -1);
    if (six < 0) {
      return null;
    }
    bitBuffer = (bitBuffer << 6) | six;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[out] = (bitBuffer >> bitCount) & 0xff;
      out += 1;
    }
    // Only the bits that no byte has consumed yet may be kept: the buffer would
    // otherwise grow without bound on a long input.
    bitBuffer &= (1 << bitCount) - 1;
  }
  return bytes;
}
