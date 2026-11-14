/**
 * Makes characters a reader cannot see visible, as <U+XXXX>, before stored
 * text reaches a model: every format character (\p{Cf}: zero-width marks,
 * bidi controls, tag characters, soft hyphen, BOM), variation selectors,
 * Mongolian variation selectors, the combining grapheme joiner, the braille
 * blank, Hangul fillers and the line/paragraph separators. Identical set to
 * the PHP reference's Support\Visible.
 */
const HIDDEN = /[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{034F}\u{180B}-\u{180F}\u{2800}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2028}\u{2029}]/gu;

export function markVisible(text: string): string {
  return toWellFormed(text).replace(HIDDEN, (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
}

/**
 * Lone surrogates cannot be encoded as UTF-8; replace them as the reference's
 * mb_scrub() replaces invalid bytes, with "?".
 */
function toWellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '?');
}

/**
 * PHP's mb_scrub() for raw bytes: decode UTF-8, replacing each invalid
 * sequence with "?". Used where bytes, not a JS string, are the input.
 */
export function scrubUtf8(bytes: Uint8Array): string {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // TextDecoder substitutes U+FFFD; PHP's mb_scrub substitutes "?". A real U+FFFD
  // in the input is preserved by checking it against a strict decode.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decoded.replace(/�/g, '?');
  }
}
