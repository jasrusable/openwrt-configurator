// The `.if` condition language.
//
//   expr       := or
//   or         := and ( (OR | "||") and )*
//   and        := not ( (AND | "&&") not )*
//   not        := (NOT | "!") not | primary
//   primary    := "(" expr ")" | "*" | name ( "==" | "!=" ) value
//                                       | name ( "<" | "<=" | ">" | ">=" ) value
//                                       | name IN "[" value ( "," value )* "]"
//   value      := 'string' | "string" | number | true | false
//
// Keywords are case-insensitive. Strings keep their spaces and take `\` escapes.
// The ordering operators compare releases (device.version < '25.12.6'): an
// rc before its release, a snapshot after its line; anything that is not a
// release, or an absent value, matches nothing.
//
// A hand-written config's `.if` is read into the typed tree the compiler
// builds directly (src/plan/when.ts), which is all the engine evaluates.
import { isFact, Literal, Order, unknownFactMessage, When } from "./plan/when";

type Token =
  | { type: "punct"; text: string; at: number }
  | { type: "string"; value: string; at: number }
  | { type: "number"; value: number; text: string; at: number }
  | { type: "word"; text: string; at: number }
  | { type: "end"; at: number };

class ConditionError extends Error {}

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (["==", "!=", "&&", "||", "<=", ">="].includes(source.slice(i, i + 2))) {
      tokens.push({ type: "punct", text: source.slice(i, i + 2), at: i });
      i += 2;
    } else if ("()[],!*<>".includes(c)) {
      tokens.push({ type: "punct", text: c, at: i });
      i++;
    } else if (c === "'" || c === '"') {
      const start = i++;
      let value = "";
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\" && i + 1 < source.length) i++;
        value += source[i++];
      }
      if (i >= source.length) {
        throw new ConditionError(`unterminated string at column ${start + 1}`);
      }
      i++;
      tokens.push({ type: "string", value, at: start });
    } else if (/[-\d]/.test(c) && /^-?\d+(\.\d+)?/.test(source.slice(i))) {
      const text = /^-?\d+(\.\d+)?/.exec(source.slice(i))![0];
      tokens.push({ type: "number", value: Number(text), text, at: i });
      i += text.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const text = /^[A-Za-z_][\w.-]*/.exec(source.slice(i))![0];
      tokens.push({ type: "word", text, at: i });
      i += text.length;
    } else {
      throw new ConditionError(`unexpected "${c}" at column ${i + 1}`);
    }
  }
  return [...tokens, { type: "end", at: source.length }];
};

/** Same-kind chains flattened, so `a AND b AND c` is one `all`. */
const join = (kind: "all" | "any", left: When, right: When): When => ({
  kind,
  of: [...(left.kind === kind ? left.of : [left]), ...(right.kind === kind ? right.of : [right])],
});

const parse = (source: string): When => {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const where = (token: Token) =>
    token.type === "end" ? "at the end" : `at column ${token.at + 1}`;
  const isKeyword = (token: Token, ...words: string[]) =>
    token.type === "word" && words.includes(token.text.toUpperCase());
  const isPunct = (token: Token, ...texts: string[]) =>
    token.type === "punct" && texts.includes(token.text);
  const expect = (text: string) => {
    const token = tokens[pos++];
    if (!isPunct(token, text)) {
      throw new ConditionError(`expected "${text}" ${where(token)}`);
    }
  };

  const value = (): Literal => {
    const token = tokens[pos++];
    if (token.type === "string") return token.value;
    // As written, since values compare by text: 25.10 is not 25.1, nor 01 1.
    if (token.type === "number") return token.text;
    if (isKeyword(token, "TRUE")) return true;
    if (isKeyword(token, "FALSE")) return false;
    throw new ConditionError(`expected a value ${where(token)}`);
  };

  const primary = (): When => {
    const token = tokens[pos];
    if (isPunct(token, "(")) {
      pos++;
      const inner = or();
      expect(")");
      return inner;
    }
    if (isPunct(token, "*")) {
      pos++;
      return { kind: "always" };
    }
    if (token.type !== "word" || isKeyword(token, "AND", "OR", "NOT", "IN")) {
      throw new ConditionError(
        `expected a name like device.tag.role ${where(token)}`
      );
    }
    // A name no device can have is a typo: refused as it is read.
    const fact = token.text;
    if (!isFact(fact)) throw new ConditionError(unknownFactMessage(fact));
    pos++;
    const op = tokens[pos++];
    if (isPunct(op, "==", "!=")) {
      const negated = (op as { text: string }).text === "!=";
      return { kind: "is", fact, value: value(), ...(negated ? { negated: true as const } : {}) };
    }
    if (isPunct(op, "<", "<=", ">", ">=")) {
      // Kept as written: 25.10 is not 25.1.
      const literal = tokens[pos++];
      if (literal.type !== "string" && literal.type !== "number") {
        throw new ConditionError(`expected a release like '25.12.6' ${where(literal)}`);
      }
      return {
        kind: "order",
        fact,
        op: (op as { text: Order }).text,
        value: literal.type === "string" ? literal.value : literal.text,
      };
    }
    if (isKeyword(op, "IN")) {
      expect("[");
      const values = [value()];
      while (isPunct(peek(), ",")) {
        pos++;
        values.push(value());
      }
      expect("]");
      return { kind: "oneOf", fact, values };
    }
    throw new ConditionError(`expected "==", "!=", "<", "<=", ">", ">=" or "in" ${where(op)}`);
  };

  const not = (): When => {
    if (isKeyword(peek(), "NOT") || isPunct(peek(), "!")) {
      pos++;
      return { kind: "not", of: not() };
    }
    return primary();
  };

  const binary =
    (kind: "all" | "any", keyword: string, symbol: string, next: () => When) =>
    (): When => {
      let left = next();
      while (isKeyword(peek(), keyword) || isPunct(peek(), symbol)) {
        pos++;
        left = join(kind, left, next());
      }
      return left;
    };
  const and = binary("all", "AND", "&&", not);
  const or = binary("any", "OR", "||", and);

  const tree = or();
  if (peek().type !== "end") {
    throw new ConditionError(`unexpected input ${where(peek())}`);
  }
  return tree;
};

/** A condition as written, read into the tree, its names checked. */
export const parseCondition = (condition: string): When => {
  try {
    return parse(condition);
  } catch (e) {
    throw new Error(`Invalid condition "${condition}": ${(e as Error).message}`);
  }
};
