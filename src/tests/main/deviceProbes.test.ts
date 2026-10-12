import test from "ava";
import { spawnSync } from "child_process";
import { ExecResult, Session } from "../../platform";
import {
  boardJson,
  installedPackages,
  managedFiles,
  pendingChanges,
  runProbe,
  runProbes,
} from "../../deviceProbes";

// A session that runs commands with the real local sh, so runProbes' batching
// is checked against an actual shell rather than a fake.
const localSh: Session = {
  execCommand: async (command): Promise<ExecResult> => {
    const r = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status };
  },
  dispose: () => {},
};
const echo = (output: string, code = 0) => ({
  command: `printf '%s' '${output.replace(/'/g, "'\\''")}'; exit ${code}`,
  parse: (r: ExecResult) => r,
});

test("runProbes keeps each probe's output and exit status apart", async (t) => {
  const answers = await runProbes(localSh, {
    multiline: echo("a\nb\n"),
    noNewline: echo("no newline"),
    empty: echo(""),
    failed: echo("partial", 3),
  });
  t.deepEqual(answers.multiline, { stdout: "a\nb\n", stderr: "", code: 0 });
  t.deepEqual(answers.noNewline, { stdout: "no newline", stderr: "", code: 0 });
  t.deepEqual(answers.empty, { stdout: "", stderr: "", code: 0 });
  t.deepEqual(answers.failed, { stdout: "partial", stderr: "", code: 3 });
});

test("a cut-short batch is an error, not a wrong answer", async (t) => {
  const truncated: Session = {
    execCommand: async () => ({
      stdout: "x\n__ONC_PROBE__0\n",
      stderr: "",
      code: null,
    }),
    dispose: () => {},
  };
  await t.throwsAsync(runProbes(truncated, { a: echo("x"), b: echo("y") }), {
    message: /cut short/,
  });
});

const result = (stdout: string, code = 0): ExecResult => ({
  stdout,
  stderr: "",
  code,
});

test("parsers read real device output", (t) => {
  t.is(
    boardJson.parse(
      result(
        '{"model":{"id":"friendlyarm,nanopi-r6s"},"network":{"lan":{"protocol":"static"}}}'
      )
    ).model?.id,
    "friendlyarm,nanopi-r6s"
  );
  t.throws(() => boardJson.parse(result("", 1)), { message: /board\.json/ });
  t.deepEqual(installedPackages.parse(result("busybox\ndropbear\n")), [
    "busybox",
    "dropbear",
  ]);
  t.deepEqual(installedPackages.parse(result("", 127)), [], "no apk at all");
  t.throws(() => installedPackages.parse(result("", 1)));
  t.deepEqual(
    managedFiles("/etc/onc/managed_files").parse(result("", 1)),
    [],
    "no manifest yet"
  );
  t.deepEqual(
    pendingChanges.parse(result("-dropbear.main\nnetwork.lan.ipaddr='x'\n")),
    { dropbear: 1, network: 1 }
  );
});

test("runProbe is the one-probe case", async (t) => {
  t.deepEqual(await runProbe(localSh, echo("ok")), {
    stdout: "ok",
    stderr: "",
    code: 0,
  });
});

// node-ssh trims stdout; the QuickJS transports do not. Batching has to work
// with both — the rig caught the Node path failing on exactly this.
test("runProbes copes with a session that trims its output", async (t) => {
  const trimming: Session = {
    execCommand: async (command) => {
      const r = await localSh.execCommand(command);
      return { ...r, stdout: r.stdout.trim() };
    },
    dispose: () => {},
  };
  const answers = await runProbes(trimming, {
    first: echo(""),
    middle: echo("x\n"),
    last: echo("y"),
  });
  t.is(answers.first.stdout, "");
  t.is(answers.middle.stdout, "x\n");
  t.is(answers.last.stdout, "y");
  t.is(answers.last.code, 0);
});
