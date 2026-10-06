// A small declarative argv parser covering what the CLI uses: subcommands
// (including nested ones like "secrets set"), required positionals, boolean,
// negatable (--no-x) and valued (--x <v>, --x=v) options, help and version.

export type OptionSpec = {
  /** "--dry-run", "--no-confirm" or "--out <dir>". */
  flags: string;
  description: string;
  /** Applied to a value given on the command line, not to `default`. */
  parse?: (value: string) => unknown;
  default?: unknown;
};

export type CommandSpec = {
  /** Space-separated for nested commands, e.g. "secrets set". */
  name: string;
  description: string;
  args?: { name: string; description: string }[];
  options?: OptionSpec[];
  action: (args: string[], options: Record<string, any>) => Promise<void>;
};

export type CliSpec = {
  name: string;
  description: string;
  version: string;
  commands: CommandSpec[];
};

type ParsedOption = OptionSpec & {
  long: string;
  key: string;
  negated: boolean;
  takesValue: boolean;
};

const parseFlags = (option: OptionSpec): ParsedOption => {
  const match = /^(--[a-z0-9][a-z0-9-]*)(?: <[^>]+>)?$/.exec(option.flags);
  if (!match) throw new Error(`Bad option flags: ${option.flags}`);
  const long = match[1];
  const negated = long.startsWith("--no-");
  return {
    ...option,
    long,
    negated,
    takesValue: option.flags.includes("<"),
    key: long
      .replace(/^--(no-)?/, "")
      .replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
  };
};

const table = (rows: [string, string][]) => {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows
    .map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)
    .join("\n");
};

const usage = (spec: CliSpec, command: CommandSpec) =>
  [
    spec.name,
    command.name,
    "[options]",
    ...(command.args || []).map((a) => `<${a.name}>`),
  ].join(" ");

const programHelp = (spec: CliSpec, prefix = "") => {
  const commands = spec.commands.filter((c) => c.name.startsWith(prefix));
  return [
    `Usage: ${spec.name} ${prefix}<command> [options]`,
    "",
    spec.description,
    "",
    "Commands:",
    table(
      commands.map((c) => [
        [c.name, ...(c.args || []).map((a) => `<${a.name}>`)].join(" "),
        c.description,
      ])
    ),
    "",
    "Options:",
    table([
      ["-V, --version", "output the version number"],
      ["-h, --help", "display help"],
    ]),
  ].join("\n");
};

const commandHelp = (spec: CliSpec, command: CommandSpec) => {
  const options = (command.options || []).map(parseFlags);
  return [
    `Usage: ${usage(spec, command)}`,
    "",
    command.description,
    ...(command.args && command.args.length > 0
      ? [
          "",
          "Arguments:",
          table(command.args.map((a) => [a.name, a.description])),
        ]
      : []),
    "",
    "Options:",
    table([
      ...options.map((o): [string, string] => [
        o.flags,
        o.default !== undefined && !o.negated
          ? `${o.description} (default: ${JSON.stringify(o.default)})`
          : o.description,
      ]),
      ["-h, --help", "display help for command"],
    ]),
  ].join("\n");
};

const usageError = (message: string, spec: CliSpec, command?: CommandSpec) =>
  new Error(
    `${message}\nRun "${spec.name}${
      command ? ` ${command.name}` : ""
    } --help" for usage.`
  );

/** Resolves once the command has run; prints help and version itself. */
export const runCli = async (spec: CliSpec, argv: string[]) => {
  const [first] = argv;
  if (first === "-V" || first === "--version") {
    console.log(spec.version);
    return;
  }
  if (first === "-h" || first === "--help") {
    console.log(programHelp(spec));
    return;
  }
  if (first === "help") {
    const target = spec.commands.find(
      (c) => c.name === argv.slice(1).join(" ")
    );
    console.log(target ? commandHelp(spec, target) : programHelp(spec));
    return;
  }

  // Longest match first, so "secrets set" wins over a hypothetical "secrets".
  const command = [...spec.commands]
    .sort((a, b) => b.name.split(" ").length - a.name.split(" ").length)
    .find((c) => {
      const words = c.name.split(" ");
      return words.every((word, i) => argv[i] === word);
    });

  if (!command) {
    const group = spec.commands.filter((c) => c.name.startsWith(`${first} `));
    if (first !== undefined && group.length > 0) {
      console.error(programHelp(spec, `${first} `));
      throw new Error(`Missing subcommand for "${first}".`);
    }
    if (first === undefined) {
      console.error(programHelp(spec));
      throw new Error("No command given.");
    }
    throw usageError(`Unknown command "${first}".`, spec);
  }

  const options = (command.options || []).map(parseFlags);
  const values: Record<string, unknown> = {};
  for (const option of options) {
    if (option.negated) values[option.key] = true;
    else if (option.default !== undefined) values[option.key] = option.default;
  }

  const rest = argv.slice(command.name.split(" ").length);
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(commandHelp(spec, command));
      return;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const option = options.find((o) => o.long === flag);
    if (!option) throw usageError(`Unknown option "${flag}".`, spec, command);
    if (!option.takesValue) {
      if (inline !== undefined) {
        throw usageError(
          `Option "${flag}" does not take a value.`,
          spec,
          command
        );
      }
      values[option.key] = !option.negated;
      continue;
    }
    const value = inline ?? rest[++i];
    if (value === undefined) {
      throw usageError(
        `Option "${option.flags}" needs a value.`,
        spec,
        command
      );
    }
    values[option.key] = option.parse ? option.parse(value) : value;
  }

  const expected = command.args || [];
  if (positionals.length < expected.length) {
    throw usageError(
      `Missing required argument <${expected[positionals.length].name}>.`,
      spec,
      command
    );
  }
  if (positionals.length > expected.length) {
    throw usageError(
      `Unexpected argument "${positionals[expected.length]}".`,
      spec,
      command
    );
  }

  await command.action(positionals, values);
};
