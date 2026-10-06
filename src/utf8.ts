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
