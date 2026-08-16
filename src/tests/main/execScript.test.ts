import test from "ava";
import { execScript } from "../../execScript";

/**
 * execScript stages the script with one exec and runs it with another, so the
 * fake answers the write call and then the run call.
 */
const fakeSsh = (run: { code: number; stdout: string; stderr?: string }) => {
  const calls: { command: string; stdin?: string }[] = [];
  const ssh = {
    execCommand: async (command: string, options?: { stdin?: string }) => {
      calls.push({ command, stdin: options?.stdin });
      if (command.includes("cat >")) return { code: 0, stdout: "", stderr: "" };
      return { code: run.code, stdout: run.stdout, stderr: run.stderr || "" };
    },
  } as any;
  return { ssh, calls };
};

const markers = (...indexes: number[]) =>
  indexes.map((i) => `__ONC_OK__${i}`).join("\n");

// The script is neither joined into one exec string (dropbear rejects those
// past ~9KB) nor piped to `sh` on stdin (the shell then shares that stdin with
// the commands it runs, so a command reading stdin can swallow the rest of the
// script). It is staged as a file and run with stdin detached.
test("execScript stages the script to a file and runs it with stdin detached", async (t) => {
  const { ssh, calls } = fakeSsh({ code: 0, stdout: markers(0, 1) });

  await execScript({ ssh, commands: ["echo a", "echo b"] });

  t.is(calls.length, 2);
  t.true(calls[0].command.includes("cat > /tmp/.onc-provision.sh"));
  // Written with a restrictive umask: the script embeds config values.
  t.true(calls[0].command.includes("umask 077"));
  t.true(calls[0].stdin!.startsWith("set -e"));
  t.true(calls[0].stdin!.includes("echo a"));
  t.true(calls[0].stdin!.includes("echo b"));

  t.true(calls[1].command.includes("sh /tmp/.onc-provision.sh"));
  t.true(calls[1].command.includes("< /dev/null"));
  // Removed after running, and the script's exit code is preserved.
  t.true(calls[1].command.includes("rm -f /tmp/.onc-provision.sh"));
  t.true(calls[1].command.includes("exit $__onc_code"));
  t.is(calls[1].stdin, undefined);
});

test("execScript reports success when every command completes", async (t) => {
  const { ssh } = fakeSsh({ code: 0, stdout: markers(0, 1, 2) });
  const result = await execScript({ ssh, commands: ["a", "b", "c"] });
  t.true(result.ok);
});

test("execScript pinpoints the failing command", async (t) => {
  // `set -e` aborts at the failure, so markers stop just before it.
  const { ssh } = fakeSsh({
    code: 1,
    stdout: markers(0, 1),
    stderr: "uci: Entry not found",
  });
  const result = await execScript({ ssh, commands: ["a", "b", "boom", "d"] });

  t.false(result.ok);
  if (result.ok) return;
  t.is(result.failedIndex, 2);
  t.is(result.command, "boom");
  t.is(result.stderr, "uci: Entry not found");
});

test("execScript fails the first command when nothing completed", async (t) => {
  const { ssh } = fakeSsh({ code: 1, stdout: "", stderr: "nope" });
  const result = await execScript({ ssh, commands: ["boom", "b"] });
  t.false(result.ok);
  if (result.ok) return;
  t.is(result.failedIndex, 0);
  t.is(result.command, "boom");
});

// A command could print something that looks like a marker. Counting the
// unbroken run from 0 means a stray high marker cannot mask a failure.
test("execScript ignores out-of-sequence markers in command output", async (t) => {
  const { ssh } = fakeSsh({ code: 1, stdout: markers(0, 9) });
  const result = await execScript({ ssh, commands: ["a", "b", "c"] });
  t.false(result.ok);
  if (result.ok) return;
  t.is(result.failedIndex, 1);
});

test("execScript reports a failure to stage the script", async (t) => {
  const ssh = {
    execCommand: async (command: string) =>
      command.includes("cat >")
        ? { code: 1, stdout: "", stderr: "Read-only file system" }
        : { code: 0, stdout: markers(0), stderr: "" },
  } as any;
  const result = await execScript({ ssh, commands: ["a"] });
  t.false(result.ok);
  if (result.ok) return;
  t.true(result.stderr.includes("Read-only file system"));
});

// A command printing without a trailing newline used to glue its output to the
// marker ("x__ONC_OK__0"), so the marker no longer started a line and a
// SUCCESSFUL script was reported as a failure at the wrong command.
test("a marker is emitted on its own line even after unterminated output", async (t) => {
  const { ssh, calls } = fakeSsh({ code: 0, stdout: markers(0, 1) });
  await execScript({ ssh, commands: ["printf x", "true"] });
  t.true(calls[0].stdin!.includes(`printf '\\n__ONC_OK__0\\n'`));
  t.false(calls[0].stdin!.includes(`echo "__ONC_OK__0"`));
});

// node-ssh removes its 'error' listener once a command is in flight, so an
// abrupt close resolves with code null instead of rejecting. Steps that can
// legitimately sever the link need to tell that apart from a failed command.
test("a channel closed without an exit status is reported as disconnected", async (t) => {
  const { ssh } = fakeSsh({ code: null as any, stdout: markers(0) });
  const result = await execScript({ ssh, commands: ["a", "b"] });
  t.false(result.ok);
  if (result.ok) return;
  t.true(result.disconnected);
  t.is(result.code, null);
});

test("a genuine non-zero exit is not reported as disconnected", async (t) => {
  const { ssh } = fakeSsh({ code: 1, stdout: markers(0), stderr: "boom" });
  const result = await execScript({ ssh, commands: ["a", "b"] });
  t.false(result.ok);
  if (result.ok) return;
  t.false(result.disconnected);
});

test("execScript issues no command for an empty script", async (t) => {
  let called = false;
  const ssh = {
    execCommand: async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;
  const result = await execScript({ ssh, commands: [] });
  t.true(result.ok);
  t.false(called);
});
