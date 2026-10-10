/**
 * Quote a value as one literal word for POSIX sh.
 *
 * Also right for `uci batch`, whose tokenizer accepts the same `'\''` form
 * (verified on 25.12.5): an unescaped `'` in a value used to abort the whole
 * provision with "unterminated '", so an SSID like "Jason's WiFi" could not be
 * set. A newline stays inside the quotes, part of the value, in both.
 */
export const shellQuote = (value: string | number) =>
  `'${String(value).replace(/'/g, `'\\''`)}'`;
