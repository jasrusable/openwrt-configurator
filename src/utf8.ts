// UTF-8 helpers that need neither Buffer nor TextEncoder/TextDecoder, which
// QuickJS does not provide.

/** Encoded length in bytes. A lone surrogate counts as U+FFFD (3), like Buffer. */
export const utf8ByteLength = (text: string) => {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

/**
 * Decode hex-encoded UTF-8, throwing on invalid sequences (overlong forms,
 * surrogates, truncation). `decodeURIComponent` is specified to reject exactly
 * those, so it serves as a strict decoder.
 */
export const decodeUtf8Hex = (hex: string) =>
  decodeURIComponent(hex.replace(/[0-9a-fA-F]{2}/g, "%$&"));

/** Text as UTF-8 bytes, without TextEncoder (QuickJS has none). */
export const toUtf8 = (text: string) => {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(bytes);
};

/** UTF-8 bytes as text, without TextDecoder. */
export const fromUtf8 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    const [length, initial] = b < 0x80 ? [1, b] : b < 0xe0 ? [2, b & 31] : b < 0xf0 ? [3, b & 15] : [4, b & 7];
    let code = initial;
    for (let j = 1; j < length; j++) code = (code << 6) | (bytes[i + j] & 63);
    text += String.fromCodePoint(code);
    i += length;
  }
  return text;
};
