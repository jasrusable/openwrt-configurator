import { parse, ParseError, printParseErrorCode } from "jsonc-parser";

// jsonc-parser locates the error; these turn its codes into what a person
// editing a config needs to read.
const messages: Record<string, string> = {
  InvalidNumberFormat: "Invalid number",
  PropertyNameExpected: "Expected a double-quoted property name",
  ValueExpected: "Expected a value",
  ColonExpected: "Expected ':' after property name",
  CommaExpected: "Expected ',' between items",
  CloseBraceExpected: "Expected ',' or '}'",
  CloseBracketExpected: "Expected ',' or ']'",
  EndOfFileExpected: "Unexpected content after the end of the JSON value",
  UnexpectedEndOfString: "Unterminated string",
  UnexpectedEndOfNumber: "Unterminated number",
  InvalidUnicode: "Invalid \\u escape in string",
  InvalidEscapeCharacter: "Invalid escape in string",
  InvalidCharacter: "Unescaped control character (e.g. a newline) in string",
};

type ParseOptions = Parameters<typeof parse>[2];

const strict: ParseOptions = {
  disallowComments: true,
  allowTrailingComma: false,
  allowEmptyContent: false,
};

// Config files are edited by hand, so they may carry comments and trailing
// commas (JSONC). Device output and everything else stays strict JSON.
const relaxed: ParseOptions = {
  disallowComments: false,
  allowTrailingComma: true,
  allowEmptyContent: false,
};

/** The first of jsonc-parser's errors, worded for a person editing a file. */
const describe = (text: string, errors: ParseError[]) => {
  if (errors.length === 0) return undefined;
  const [error, then] = errors;
  const code = printParseErrorCode(error.error);
  // An unquoted key shows up as a stray symbol followed by "property name
  // expected"; say what is actually wrong.
  const unquotedKey =
    code === "InvalidSymbol" &&
    then !== undefined &&
    printParseErrorCode(then.error) === "PropertyNameExpected";
  const next = text[error.offset];
  const trailingComma =
    (next === "}" || next === "]") &&
    text.slice(0, error.offset).trimEnd().endsWith(",");
  return {
    offset: error.offset,
    message: trailingComma
      ? `Trailing comma before '${next}'`
      : error.offset >= text.length
      ? "Unexpected end of input"
      : unquotedKey
      ? `Expected a double-quoted property name, found ${JSON.stringify(next)}`
      : code === "InvalidSymbol"
      ? `Unexpected ${JSON.stringify(next)}`
      : messages[code] ?? code,
  };
};

/**
 * Locate the first syntax error in strict JSON, or return undefined if valid.
 *
 * Only run after `JSON.parse` has already failed. Engines disagree on what
 * their errors say: Node often names no position at all, QuickJS gives a line
 * but different wording. Locating it ourselves gives the same message on both.
 */
export const findJsonError = (text: string) => {
  const errors: ParseError[] = [];
  parse(text, errors, strict);
  return describe(text, errors);
};

// Where, never what: the line may hold a password, and this message reaches
// the terminal, the UI's Problems and logs.
const located = (text: string, filepath: string | undefined, error: { offset: number; message: string }) => {
  const before = text.slice(0, error.offset);
  const line = before.split("\n").length;
  const column = error.offset - (before.lastIndexOf("\n") + 1) + 1;
  return new Error(`${filepath ?? "JSON"}:${line}:${column}: ${error.message}`);
};

/** Strict JSON, as devices and tools print it. */
export const parseJson = (text: string, filepath?: string) => {
  try {
    return JSON.parse(text);
  } catch {
    const error = findJsonError(text);
    // The engine's own message quotes the text (Node's does).
    if (!error) throw new Error(`${filepath ?? "JSON"}: not valid JSON`);
    throw located(text, filepath, error);
  }
};

/** A hand-edited config file: JSON plus comments and trailing commas. */
export const parseConfigJson = (text: string, filepath?: string) => {
  const errors: ParseError[] = [];
  const value = parse(text, errors, relaxed);
  const error = describe(text, errors);
  if (error) throw located(text, filepath, error);
  return value;
};
