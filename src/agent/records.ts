// What an agent verb is told: the run's data, on stdin, never in the script or
// on its command line (argv is readable by every process, and dropbear refuses
// a long exec request). A record a line, "<kind> <fields>", the last field the
// only one that may hold spaces (a path); some are followed by a body of as
// many lines as their header counts, sent as is. The stream ends with "end", so
// one cut short is refused before anything is done. No field holds a line
// break: a managed path with one is refused before arming (agent.unarmable).

export type AgentRecord =
  /** prepare: an owned config, written only if the device has none (a package's first start then reads it). */
  | { kind: "seed"; path: string; content: string }
  /** prepare: packages, each removed (with what depends on it) or installed. */
  | { kind: "remove" | "add"; name: string }
  /** stage: uci operations, a line each, through one `uci batch`. */
  | { kind: "batch"; operations: string[] }
  /** stage: one operation whose value spans lines, which a batch would misread. */
  | { kind: "set" | "add_list"; key: string; value: string }
  /** stage: a managed file no longer declared (an init script is stopped and disabled first). */
  | { kind: "remove-file"; path: string }
  /** stage: a managed file, replaced only if it differs, and then `runAfter` run. */
  | { kind: "write"; path: string; mode: string; content: string; runAfter?: string }
  /** finalise: a config to commit, if the device has it. */
  | { kind: "commit"; config: string }
  /** finalise: a protocol netifd must know after the reload, or it is restarted. */
  | { kind: "protocol"; name: string }
  /** services: enabled and started, or stopped and disabled. */
  | { kind: "enable" | "disable"; name: string }
  /** hooks: a command, run once the config is live. */
  | { kind: "run"; command: string };

/** Text as a body: what is written, ending in a line break (a file's last line gains one, as it always has). */
const asBody = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
/** A value as a body: its text and one line break, which the agent takes off again. */
const valueBody = (text: string) => `${text}\n`;
const lines = (body: string) => body.split("\n").length - 1;

const field = (value: string, what: string) => {
  if (value === "" || /[\s]/.test(value)) throw new Error(`An agent record's ${what} must be one word: ${JSON.stringify(value)}`);
  return value;
};
const lastField = (value: string, what: string) => {
  if (value === "" || /[\n\r]/.test(value)) throw new Error(`An agent record's ${what} must be one line: ${JSON.stringify(value)}`);
  return value;
};

const encodeOne = (record: AgentRecord): string => {
  switch (record.kind) {
    case "seed": {
      const body = asBody(record.content);
      return `seed ${lines(body)} ${lastField(record.path, "path")}\n${body}`;
    }
    case "remove":
    case "add":
    case "commit":
    case "protocol":
    case "enable":
    case "disable":
      return `${record.kind} ${field("name" in record ? record.name : record.config, "name")}\n`;
    case "batch": {
      const body = record.operations.map((operation) => lastField(operation, "operation")).join("\n") + "\n";
      return `batch ${lines(body)}\n${body}`;
    }
    case "set":
    case "add_list": {
      const body = valueBody(record.value);
      return `${record.kind} ${lines(body)} ${field(record.key, "key")}\n${body}`;
    }
    case "remove-file":
      return `remove-file ${lastField(record.path, "path")}\n`;
    case "write": {
      const content = asBody(record.content);
      const after = record.runAfter === undefined ? "" : valueBody(record.runAfter);
      return `write ${lines(content)} ${lines(after)} ${field(record.mode, "mode")} ${lastField(record.path, "path")}\n${content}${after}`;
    }
    case "run": {
      const body = valueBody(record.command);
      return `run ${lines(body)}\n${body}`;
    }
  }
};

/** A verb's stdin. */
export const encodeRecords = (records: AgentRecord[]) => records.map(encodeOne).join("") + "end\n";

/** The records a verb's stdin holds: what the agent reads, read the same way (tests, the fake device). */
export const decodeRecords = (text: string): AgentRecord[] => {
  const all = text.split("\n");
  if (all[all.length - 2] !== "end") throw new Error("agent records: cut short (no end)");
  const records: AgentRecord[] = [];
  let at = 0;
  const take = (count: number) => {
    const body = all.slice(at, at + count).join("\n") + "\n";
    at += count;
    return body;
  };
  const value = (body: string) => body.slice(0, -1);
  while (all[at] !== "end") {
    const header = all[at++];
    const [kind, ...rest] = header.split(" ");
    const after = (n: number) => rest.slice(n).join(" ");
    switch (kind) {
      case "seed":
        records.push({ kind, path: after(1), content: take(Number(rest[0])) });
        break;
      case "remove":
      case "add":
      case "protocol":
      case "enable":
      case "disable":
        records.push({ kind, name: after(0) });
        break;
      case "commit":
        records.push({ kind, config: after(0) });
        break;
      case "batch":
        records.push({ kind, operations: value(take(Number(rest[0]))).split("\n") });
        break;
      case "set":
      case "add_list":
        records.push({ kind, key: after(1), value: value(take(Number(rest[0]))) });
        break;
      case "remove-file":
        records.push({ kind, path: after(0) });
        break;
      case "write": {
        const content = take(Number(rest[0]));
        const runAfter = Number(rest[1]) > 0 ? value(take(Number(rest[1]))) : undefined;
        records.push({ kind, mode: rest[2], path: after(3), content, ...(runAfter === undefined ? {} : { runAfter }) });
        break;
      }
      case "run":
        records.push({ kind, command: value(take(Number(rest[0]))) });
        break;
      default:
        throw new Error(`agent records: unknown kind ${JSON.stringify(kind)}`);
    }
  }
  return records;
};
