// When a declaration applies: a small typed tree over what is known of a
// device (its tags, name, model, release, switch, radios). The compiler
// builds it with the constructors below; a hand-written config's `.if`
// string is parsed into the same tree (src/condition.ts), and printed back
// from it (`printWhen`). The engine only ever evaluates trees.
import { compareReleases } from "../release";

type RadioBand = "2g" | "5g" | "6g";

/** What a condition can ask of a device. */
export type Fact =
  | `device.tag.${string}`
  | "device.hostname"
  | "device.ipaddr"
  | "device.model_id"
  | "device.version"
  | "device.target"
  | "device.sw_config"
  | `device.wifi_${RadioBand}`
  | `device.mesh_${RadioBand}`;

export type Literal = string | boolean;
export type Order = "<" | "<=" | ">" | ">=";

export type When =
  | { kind: "always" }
  | { kind: "is"; fact: Fact; value: Literal; negated?: true }
  | { kind: "oneOf"; fact: Fact; values: Literal[] }
  | { kind: "order"; fact: Fact; op: Order; value: string }
  | { kind: "all"; of: When[] }
  | { kind: "any"; of: When[] }
  | { kind: "not"; of: When };

const radioBands: RadioBand[] = ["2g", "5g", "6g"];
const builtInFacts: Fact[] = [
  "device.sw_config",
  "device.hostname",
  "device.ipaddr",
  "device.model_id",
  "device.version",
  "device.target",
  ...radioBands.map((band): Fact => `device.wifi_${band}`),
  ...radioBands.map((band): Fact => `device.mesh_${band}`),
];

/** Whether a name in a condition is one a device has: a tag, or a built-in. */
export const isFact = (name: string): name is Fact =>
  (name.startsWith("device.tag.") && name.length > "device.tag.".length) || (builtInFacts as string[]).includes(name);

export const unknownFactMessage = (name: string) =>
  `unknown name ${name}; use device.tag.<key> or one of ${builtInFacts.join(", ")}`;

const always: When = { kind: "always" };

/**
 * Nested ones of a kind flattened, and `always` absorbed (it adds nothing to
 * an all, and makes an any always); none at all is every device (all) or
 * none (any).
 */
const joined = (kind: "all" | "any", of: When[]): When => {
  if (kind === "any" && of.some((n) => n.kind === "always")) return always;
  const flat = of.filter((n) => n.kind !== "always").flatMap((n) => (n.kind === kind ? n.of : [n]));
  if (flat.length === 0) return kind === "all" ? always : { kind: "not", of: always };
  return flat.length === 1 ? flat[0] : { kind, of: flat };
};

/** The constructors the compiler writes conditions with. */
export const when = {
  always,
  is: (fact: Fact, value: Literal): When => ({ kind: "is", fact, value }),
  oneOf: (fact: Fact, values: Literal[]): When => ({ kind: "oneOf", fact, values }),
  order: (fact: Fact, op: Order, value: string): When => ({ kind: "order", fact, op, value }),
  /** Nested ones flattened, so a tree prints and reads back as itself; one condition is itself. */
  all: (...of: When[]): When => joined("all", of),
  any: (...of: When[]): When => joined("any", of),
  not: (of: When): When => ({ kind: "not", of }),
  role: (role: string) => when.is("device.tag.role", role),
  tag: (key: string, value: string) => when.is(`device.tag.${key}`, value),
  device: (hostname: string) => when.is("device.hostname", hostname),
  swConfig: (on: boolean) => when.is("device.sw_config", on),
  radio: (band: RadioBand) => when.is(`device.wifi_${band}`, true),
  meshRadio: (band: RadioBand) => when.is(`device.mesh_${band}`, true),
};

/** Every fact a condition mentions, in branches evaluation may skip too. */
export const factsIn = (node: When): Fact[] =>
  node.kind === "always"
    ? []
    : node.kind === "all" || node.kind === "any"
      ? node.of.flatMap(factsIn)
      : node.kind === "not"
        ? factsIn(node.of)
        : [node.fact];

/**
 * What a fact is on a device. `value: undefined` means absent (a tag this
 * device does not set); throw for a name that cannot exist at all.
 */
export type Lookup = (name: string) => { value?: Literal | number | (Literal | number)[] };

/** Whether `node` holds, asking `lookup` for each fact. */
const evaluate = (node: When, lookup: Lookup): boolean => {
  switch (node.kind) {
    case "always":
      return true;
    case "all":
      return node.of.every((n) => evaluate(n, lookup));
    case "any":
      return node.of.some((n) => evaluate(n, lookup));
    case "not":
      return !evaluate(node.of, lookup);
    case "order": {
      // Releases compared as releases (an rc before its release, a snapshot
      // after its line); anything that is not a release matches nothing.
      const { value } = lookup(node.fact);
      const order = typeof value === "string" ? compareReleases(value, node.value) : undefined;
      if (order === undefined) return false;
      return { "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0 }[node.op];
    }
    case "is":
    case "oneOf": {
      const { value } = lookup(node.fact);
      const wanted = node.kind === "oneOf" ? node.values : [node.value];
      // By text: `device.sw_config == 'true'` and `device.tag.floor == 2`
      // mean what they say, though one side is a boolean or a number. An
      // absent value (a tag this device does not set) matches nothing.
      const same = (a: unknown, b: Literal) => String(a) === String(b);
      const matches =
        value !== undefined && wanted.some((w) => (Array.isArray(value) ? value.some((v) => same(v, w)) : same(value, w)));
      return node.kind === "is" && node.negated ? !matches : matches;
    }
  }
};

/** Each fact looked up first, so a mistyped name fails even in a branch an OR would skip. */
export const evaluateChecked = (node: When, lookup: Lookup) => {
  factsIn(node).forEach((fact) => lookup(fact));
  return evaluate(node, lookup);
};

const printLiteral = (value: Literal) => (typeof value === "boolean" ? String(value) : `'${value.replace(/[\\']/g, "\\$&")}'`);

/** As the `.if` language writes it: what a hand-written config would say. */
export const printWhen = (node: When): string => {
  const inner = (child: When, parent: "all" | "any" | "not") =>
    (child.kind === "any" && parent !== "any") || (child.kind === "all" && parent === "not")
      ? `(${printWhen(child)})`
      : printWhen(child);
  switch (node.kind) {
    case "always":
      return "*";
    case "is":
      return `${node.fact} ${node.negated ? "!=" : "=="} ${printLiteral(node.value)}`;
    case "oneOf":
      return `${node.fact} in [${node.values.map(printLiteral).join(", ")}]`;
    case "order":
      return `${node.fact} ${node.op} '${node.value}'`;
    case "all":
      return node.of.map((n) => inner(n, "all")).join(" AND ");
    case "any":
      return node.of.map((n) => inner(n, "any")).join(" OR ");
    case "not":
      return `NOT ${inner(node.of, "not")}`;
  }
};
