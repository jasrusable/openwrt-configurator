import test from "ava";
import { CliSpec, runCli } from "../../args";

const capture = () => {
  const calls: {
    name: string;
    args: string[];
    options: Record<string, any>;
  }[] = [];
  const spec: CliSpec = {
    name: "onc",
    description: "test",
    version: "1.2.3",
    commands: [
      {
        name: "provision",
        description: "provision",
        args: [{ name: "config-file", description: "config" }],
        options: [
          { flags: "--no-confirm", description: "skip confirm" },
          {
            flags: "--confirm-timeout <seconds>",
            description: "timeout",
            parse: (v) => parseInt(v, 10),
            default: 90,
          },
          { flags: "--identity <path>", description: "key" },
          { flags: "--dry-run", description: "dry" },
        ],
        action: async (args, options) => {
          calls.push({ name: "provision", args, options });
        },
      },
      {
        name: "secrets set",
        description: "store",
        args: [{ name: "name", description: "name" }],
        action: async (args, options) => {
          calls.push({ name: "secrets set", args, options });
        },
      },
    ],
  };
  return { spec, calls };
};

test("defaults, negation and camelCased keys", async (t) => {
  const { spec, calls } = capture();
  await runCli(spec, ["provision", "net.json"]);
  t.deepEqual(calls[0], {
    name: "provision",
    args: ["net.json"],
    options: { confirm: true, confirmTimeout: 90 },
  });
});

test("values are parsed, in either --x v or --x=v form, around positionals", async (t) => {
  const { spec, calls } = capture();
  await runCli(spec, [
    "provision",
    "--no-confirm",
    "net.json",
    "--confirm-timeout=120",
    "--identity",
    "~/.ssh/k",
    "--dry-run",
  ]);
  t.deepEqual(calls[0].args, ["net.json"]);
  t.deepEqual(calls[0].options, {
    confirm: false,
    confirmTimeout: 120,
    identity: "~/.ssh/k",
    dryRun: true,
  });
});

test("nested commands", async (t) => {
  const { spec, calls } = capture();
  await runCli(spec, ["secrets", "set", "wifi/home"]);
  t.deepEqual(calls[0], {
    name: "secrets set",
    args: ["wifi/home"],
    options: {},
  });
});

test("usage errors", async (t) => {
  const { spec, calls } = capture();
  await t.throwsAsync(runCli(spec, ["provision"]), {
    message: /Missing required argument <config-file>/,
  });
  await t.throwsAsync(runCli(spec, ["provision", "a", "b"]), {
    message: /Unexpected argument "b"/,
  });
  await t.throwsAsync(runCli(spec, ["provision", "a", "--bogus"]), {
    message: /Unknown option "--bogus"/,
  });
  await t.throwsAsync(runCli(spec, ["provision", "a", "--identity"]), {
    message: /needs a value/,
  });
  await t.throwsAsync(runCli(spec, ["provision", "a", "--dry-run=1"]), {
    message: /does not take a value/,
  });
  await t.throwsAsync(runCli(spec, ["frobnicate"]), {
    message: /Unknown command "frobnicate"/,
  });
  t.is(calls.length, 0);
});

test("help and version run no command", async (t) => {
  const { spec, calls } = capture();
  const logged: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => logged.push(parts.join(" "));
  try {
    await runCli(spec, ["--version"]);
    await runCli(spec, ["provision", "--help"]);
  } finally {
    console.log = log;
  }
  t.is(logged[0], "1.2.3");
  t.true(logged[1].includes("Usage: onc provision [options] <config-file>"));
  t.true(logged[1].includes("(default: 90)"));
  t.is(calls.length, 0);
});
