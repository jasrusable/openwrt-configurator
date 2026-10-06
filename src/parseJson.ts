type JsonSyntaxError = { offset: number; message: string };

/**
 * Locate the first syntax error in `text`, or return undefined if it is valid.
 *
 * Only run after `JSON.parse` has already failed. Engines disagree on what
 * their errors say: Node often names no position at all, QuickJS gives a line
 * but different wording. Scanning ourselves gives the same, located message
 * everywhere, which matters for a hand-edited config.
 */
export const findJsonError = (text: string): JsonSyntaxError | undefined => {
  let i = 0;
  const failure = (message: string): JsonSyntaxError => ({
    offset: i,
    message,
  });
  const found = () =>
    i >= text.length ? "end of input" : JSON.stringify(text[i]);
  const skipWhitespace = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };

  const string = (): JsonSyntaxError | undefined => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") {
        const escape = text[i + 1];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            return failure("Invalid \\u escape in string");
          }
          i += 6;
        } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
          i += 2;
        } else {
          return failure("Invalid escape in string");
        }
      } else if (c < " ") {
        return failure(
          "Unescaped control character (e.g. a newline) in string"
        );
      } else {
        i++;
      }
    }
    return failure("Unterminated string");
  };

  const literal = (word: string) => {
    if (!text.startsWith(word, i)) return failure(`Unexpected ${found()}`);
    i += word.length;
  };

  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) return failure(`Invalid number`);
    i += match[0].length;
  };

  const object = (): JsonSyntaxError | undefined => {
    i++;
    skipWhitespace();
    if (text[i] === "}") {
      i++;
      return;
    }
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') {
        return failure(
          text[i] === "}"
            ? "Trailing comma before '}'"
            : `Expected a double-quoted property name, found ${found()}`
        );
      }
      const keyError = string();
      if (keyError) return keyError;
      skipWhitespace();
      if (text[i] !== ":") {
        return failure(`Expected ':' after property name, found ${found()}`);
      }
      i++;
      const valueError = value();
      if (valueError) return valueError;
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      return failure(
        `Expected ',' or '}' after property value, found ${found()}`
      );
    }
  };

  const array = (): JsonSyntaxError | undefined => {
    i++;
    skipWhitespace();
    if (text[i] === "]") {
      i++;
      return;
    }
    for (;;) {
      skipWhitespace();
      if (text[i] === "]") return failure("Trailing comma before ']'");
      const valueError = value();
      if (valueError) return valueError;
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      return failure(
        `Expected ',' or ']' after array element, found ${found()}`
      );
    }
  };

  const value = (): JsonSyntaxError | undefined => {
    skipWhitespace();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "t") return literal("true");
    if (c === "f") return literal("false");
    if (c === "n") return literal("null");
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    return failure(`Unexpected ${found()}`);
  };

  const error = value();
  if (error) return error;
  skipWhitespace();
  return i < text.length
    ? failure(`Unexpected ${found()} after the end of the JSON value`)
    : undefined;
};

const locate = (text: string, offset: number) => {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = text.indexOf("\n", offset);
  return {
    line,
    column: offset - lineStart + 1,
    lineText: text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd),
  };
};

export const parseJson = (text: string, filepath?: string) => {
  try {
    return JSON.parse(text);
  } catch (e) {
    const error = findJsonError(text);
    if (!error) {
      throw new Error(`${filepath ?? "JSON"}: ${(e as Error).message}`);
    }
    const { line, column, lineText } = locate(text, error.offset);
    throw new Error(
      `${filepath ?? "JSON"}:${line}:${column}: ${error.message}\n\n` +
        `  ${lineText}\n  ${" ".repeat(column - 1)}^`
    );
  }
};
