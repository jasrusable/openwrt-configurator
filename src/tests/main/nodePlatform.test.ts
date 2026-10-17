import test from "ava";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import { tempDir } from "../helpers/tempDir";

// A program that exits without reading its input closes the pipe before the
// write lands. Node reports that as an unhandled EPIPE on stdin and crashed
// the whole CLI; the rig hit it with `ip route` during gateway detection.
test("run survives a program that ignores its stdin", async (t) => {
  for (let i = 0; i < 50; i++) {
    const result = await nodePlatform.run(["true"], { stdin: "x".repeat(200000) });
    t.is(result.code, 0);
  }
});

// A shell's subshell kept running after the shell was killed: the time limit
// ends the whole group, and a program has no terminal to prompt on.
test("run's time limit ends the program and whatever it started", async (t) => {
  const dir = tempDir("runlimit");
  const marker = join(dir, "still-running");
  const started = Date.now();
  const result = await nodePlatform.run(["sh", "-c", `( sleep 1; touch ${marker} ) & wait`], { timeoutMs: 200 });
  t.like(result, { code: null, timedOut: true });
  t.true(Date.now() - started < 1000);
  await nodePlatform.sleep(1500);
  t.false(existsSync(marker), "the subshell went with it");
  t.like(await nodePlatform.run(["sh", "-c", "( : </dev/tty ) 2>/dev/null && echo tty || echo no-tty"], { timeoutMs: 5000 }), { code: 0, stdout: "no-tty\n" });
});

test("a private directory is made owner-only, and one that is a link, open to others or not a directory is refused", (t) => {
  const dir = tempDir("private");
  nodePlatform.privateDir(join(dir, "new/inner"));
  t.is(statSync(join(dir, "new/inner")).mode & 0o777, 0o700);
  nodePlatform.privateDir(join(dir, "new/inner"));
  mkdirSync(join(dir, "elsewhere"), { mode: 0o700 });
  symlinkSync(join(dir, "elsewhere"), join(dir, "link"));
  t.throws(() => nodePlatform.privateDir(join(dir, "link")), { message: /not this program's own/ });
  mkdirSync(join(dir, "open"));
  chmodSync(join(dir, "open"), 0o777);
  t.throws(() => nodePlatform.privateDir(join(dir, "open")), { message: /not this program's own/ });
  writeFileSync(join(dir, "file"), "");
  t.throws(() => nodePlatform.privateDir(join(dir, "file")));
});

test("SSH with no known_hosts file and no pinned key is refused, never any key accepted", async (t) => {
  await t.throwsAsync(
    nodePlatform.connect({ host: "192.0.2.1", username: "root", readyTimeout: 1000, keepaliveInterval: 5000, keepaliveCountMax: 3 }),
    { message: /no known_hosts file and no host key/ }
  );
});
