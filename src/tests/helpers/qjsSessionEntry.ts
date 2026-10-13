// Bundled and run under qjs by qjsParity.test.ts: the session layer over the
// local transport (sh), which shares all of its wrapping with SSH.
import "../../platforms/qjsGlobals";
import * as agent from "../../agent";
import { hookRecords } from "../../getDeviceScript";
import { qjsPlatform as platform } from "../../platforms/qjs";
import { read, write } from "../../store";
import { z } from "zod";

const results: string[] = [];
const check = (name: string, ok: boolean, detail: unknown) =>
  results.push(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`
  );

const main = async () => {
  const s = await platform.connect({
    host: "localhost",
    readyTimeout: 5000,
    keepaliveInterval: 5000,
    keepaliveCountMax: 3,
  });
  check("session is local", s.local === true, s.local);

  let r = await s.execCommand("echo out; echo err >&2; false || exit 3");
  check(
    "exit code and streams",
    r.code === 3 && r.stdout === "out\n" && r.stderr === "err\n",
    r
  );

  r = await s.execCommand("exit 0");
  check("exit inside the command", r.code === 0, r);

  const big = "x".repeat(200000) + "\n";
  r = await s.execCommand("wc -c", { stdin: big });
  check(
    "200 KB stdin",
    r.code === 0 && r.stdout.trim() === String(big.length),
    r.stdout
  );

  r = await s.execCommand("echo partial; kill -9 $$");
  check(
    "killed shell reports code null",
    r.code === null && r.stdout === "partial\n",
    r
  );

  r = await s.execCommand("cat <<'EOF'\nheredoc ok\nEOF");
  check("heredoc", r.code === 0 && r.stdout === "heredoc ok\n", r);

  // The agent over this transport: written with its first verb, a step
  // verb's records on stdin, the step it stopped at, and its clean-up.
  const runId = `parity${Math.random().toString(36).slice(2, 8)}`;
  const installed = await agent.call(s, agent.install(runId));
  check("agent installed", installed.ok && installed.value, installed);
  const done = await agent.call(s, agent.hooks(runId, hookRecords(["echo one", "printf 'no newline'", "true"])));
  check("agent steps done", done.ok && done.value.done, done);
  const stopped = await agent.call(s, agent.hooks(runId, hookRecords(["true", "echo two", "false", "echo never"])));
  check("agent step that failed", stopped.ok && !stopped.value.done && stopped.value.step === "hook 3", stopped);
  const finished = await agent.call(s, agent.finish(runId));
  check("agent done", finished.ok && finished.value, finished);

  // The store over QuickJS's files: atomic writes with their mode, nothing
  // left beside them, and a directory listed sorted, without . and ..
  const dir = (await platform.run(["mktemp", "-d"])).stdout.trim();
  const key = (name: string) => ({ path: `${dir}/${name}`, schema: z.object({ n: z.number() }), format: 1 });
  write(platform, key("b.json"), { n: 2 });
  write(platform, key("a.json"), { n: 1 });
  write(platform, key("a.json"), { n: 3 });
  check("listDir", JSON.stringify(platform.listDir(dir)) === JSON.stringify(["a.json", "b.json"]), platform.listDir(dir));
  check("store reads back", read(platform, key("a.json"))?.n === 3, read(platform, key("a.json")));
  check("store writes owner-only", platform.fileMode(`${dir}/a.json`) === 0o600, platform.fileMode(`${dir}/a.json`));
  check("listDir of nothing", platform.listDir(`${dir}/missing`).length === 0, platform.listDir(`${dir}/missing`));
  await platform.run(["rm", "-rf", dir]);
};

main().then(
  () => {
    console.log(results.join("\n"));
    platform.exit(0);
  },
  (e) => {
    console.log(results.join("\n"));
    console.error(`session check crashed: ${(e as Error)?.message ?? e}`);
    platform.exit(1);
  }
);
