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
import { compareReleases } from "./release";

type Value = string | number | boolean;

type Node =
  | { kind: "always" }
  | { kind: "or" | "and"; left: Node; right: Node }
  | { kind: "not"; operand: Node }
  | { kind: "compare"; op: "==" | "!="; name: string; value: Value }
  | { kind: "order"; op: Order; name: string; value: string }
  | { kind: "in"; name: string; values: Value[] };

type Order = "<" | "<=" | ">" | ">=";

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

const parse = (source: string): Node => {
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

  const value = (): Value => {
    const token = tokens[pos++];
    if (token.type === "string" || token.type === "number") return token.value;
    if (isKeyword(token, "TRUE")) return true;
    if (isKeyword(token, "FALSE")) return false;
    throw new ConditionError(`expected a value ${where(token)}`);
  };

  const primary = (): Node => {
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
    pos++;
    const op = tokens[pos++];
    if (isPunct(op, "==", "!=")) {
      return {
        kind: "compare",
        op: (op as { text: "==" | "!=" }).text,
        name: token.text,
        value: value(),
      };
    }
    if (isPunct(op, "<", "<=", ">", ">=")) {
      // Kept as written: 25.10 is not 25.1.
      const literal = tokens[pos++];
      if (literal.type !== "string" && literal.type !== "number") {
        throw new ConditionError(`expected a release like '25.12.6' ${where(literal)}`);
      }
      return {
        kind: "order",
        op: (op as { text: Order }).text,
        name: token.text,
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
      return { kind: "in", name: token.text, values };
    }
    throw new ConditionError(`expected "==", "!=", "<", "<=", ">", ">=" or "in" ${where(op)}`);
  };

  const not = (): Node => {
    if (isKeyword(peek(), "NOT") || isPunct(peek(), "!")) {
      pos++;
      return { kind: "not", operand: not() };
    }
    return primary();
  };

  const binary =
    (kind: "and" | "or", keyword: string, symbol: string, next: () => Node) =>
    (): Node => {
      let left = next();
      while (isKeyword(peek(), keyword) || isPunct(peek(), symbol)) {
        pos++;
        left = { kind, left, right: next() };
      }
      return left;
    };
  const and = binary("and", "AND", "&&", not);
  const or = binary("or", "OR", "||", and);

  const tree = or();
  if (peek().type !== "end") {
    throw new ConditionError(`unexpected input ${where(peek())}`);
  }
  return tree;
};

/**
 * What a name in a condition refers to. `value: undefined` means absent (a
 * tag this device does not set); throw for a name that cannot exist at all.
 */
export type Lookup = (name: string) => { value?: Value | Value[] };

const evaluate = (node: Node, lookup: Lookup): boolean => {
  switch (node.kind) {
    case "always":
      return true;
    case "or":
      return evaluate(node.left, lookup) || evaluate(node.right, lookup);
    case "and":
      return evaluate(node.left, lookup) && evaluate(node.right, lookup);
    case "not":
      return !evaluate(node.operand, lookup);
    case "order": {
      const { value } = lookup(node.name);
      const order = typeof value === "string" ? compareReleases(value, node.value) : undefined;
      if (order === undefined) return false;
      return { "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0 }[node.op];
    }
    case "compare":
    case "in": {
      const { value } = lookup(node.name);
      const wanted = node.kind === "in" ? node.values : [node.value];
      // An absent value (a tag this device does not set) matches nothing.
      const matches =
        value !== undefined &&
        wanted.some((w) =>
          Array.isArray(value) ? value.includes(w) : value === w
        );
      return node.kind === "compare" && node.op === "!=" ? !matches : matches;
    }
  }
};

export const evaluateCondition = (condition: string, lookup: Lookup) => {
  try {
    return evaluate(parse(condition), lookup);
  } catch (e) {
    throw new Error(
      `Invalid condition "${condition}": ${(e as Error).message}`
    );
  }
};
