// Bundled and run under qjs by qjsParity.test.ts: the session layer over the
// local transport (sh), which shares all of its wrapping with SSH.
import "../../platforms/qjsGlobals";
import { execScript } from "../../execScript";
import { qjsPlatform as platform } from "../../platforms/qjs";

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

  const ok = await execScript({
    ssh: s,
    commands: ["echo one", "printf 'no newline'", "true"],
  });
  check("execScript success", ok.ok, ok);

  const bad = await execScript({
    ssh: s,
    commands: ["true", "echo two", "false", "echo never"],
  });
  check(
    "execScript failing index",
    !bad.ok && bad.failedIndex === 2 && !bad.disconnected,
    bad
  );
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
