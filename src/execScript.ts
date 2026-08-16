import { NodeSSH } from "node-ssh";

export type ScriptResult =
  | { ok: true }
  | {
      ok: false;
      failedIndex: number;
      command: string;
      stderr: string;
      code: number | null;
      /**
       * The channel closed without an exit status, which node-ssh reports as a
       * resolved promise with `code: null` rather than by rejecting. For steps
       * that can legitimately sever the link (commit, reload_config) this is
       * expected rather than a failure.
       */
      disconnected: boolean;
    };

const MARKER = "__ONC_OK__";
/**
 * Per-process so two runs against one device cannot clobber each other's
 * script. It embeds config values, so it is written 0600 and trapped for
 * removal even if the connection drops mid-run.
 */
export const stagedScriptPath = `/tmp/.onc-provision-${process.pid}.sh`;

/**
 * Run a list of commands on the device as one script.
 *
 * Issuing one `ssh.execCommand` per command opens a separate SSH channel each
 * time, which dominates everything else: measured against a LAN OpenWrt device,
 * 59ms per command versus ~1.3ms when they share a channel. A 320-command
 * provision takes ~19s that way and well under a second this way.
 *
 * The commands cannot simply be joined into one exec string — dropbear rejects
 * exec requests over ~9KB and drops the connection on larger ones, and a
 * realistic provision script is past that. They are also not piped straight to
 * `sh` over stdin: the shell then shares that stdin with the commands it runs,
 * so a command that reads stdin can swallow the not-yet-parsed remainder of the
 * script. Whether it does depends on how much the shell happened to buffer,
 * which makes the failure size-dependent and intermittent.
 *
 * So the script is written to a file first and run with stdin detached, which
 * is deterministic and keeps heredocs working. `set -e` aborts at the first
 * failing command and a marker echoed after each one records how far we got,
 * so callers keep the per-command granularity they need to roll back.
 */
export const execScript = async ({
  ssh,
  commands,
}: {
  ssh: NodeSSH;
  commands: string[];
}): Promise<ScriptResult> => {
  if (commands.length === 0) {
    return { ok: true };
  }

  const script = [
    "set -e",
    // The `rm -f` in the run command only fires if the exec completes; a
    // dropped connection sends HUP to the script instead, so clean up here too.
    `trap 'rm -f ${stagedScriptPath}' EXIT INT TERM HUP`,
    ...commands.flatMap((command, index) => [
      command,
      // Leading newline: a command that prints without a trailing newline
      // would otherwise glue its output to the marker ("x__ONC_OK__0") and the
      // marker would no longer start a line, turning a success into a failure.
      `printf '\\n${MARKER}${index}\\n'`,
    ]),
    "",
  ].join("\n");

  // The script embeds config values, so keep it unreadable to other users and
  // remove it as soon as it has run.
  const written = await ssh.execCommand(`umask 077 && cat > ${stagedScriptPath}`, {
    stdin: script,
  });
  if (written.code !== 0) {
    return {
      ok: false,
      failedIndex: 0,
      command: commands[0],
      stderr: `Failed to stage the provisioning script: ${written.stderr}`,
      code: written.code,
      disconnected: written.code === null,
    };
  }

  const result = await ssh.execCommand(
    `sh ${stagedScriptPath} < /dev/null; __onc_code=$?; rm -f ${stagedScriptPath}; exit $__onc_code`
  );

  const markerPattern = new RegExp(`^${MARKER}(\\d+)$`);
  const seen = new Set(
    result.stdout
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(markerPattern);
        return match ? [Number(match[1])] : [];
      })
  );

  // Count the unbroken run from 0 rather than taking the highest marker seen,
  // so a command whose own output happens to look like a marker cannot make a
  // failed script look complete.
  let lastCompleted = -1;
  while (seen.has(lastCompleted + 1)) {
    lastCompleted += 1;
  }

  if (result.code === 0 && lastCompleted === commands.length - 1) {
    return { ok: true };
  }

  const failedIndex = Math.min(lastCompleted + 1, commands.length - 1);
  return {
    ok: false,
    failedIndex,
    command: commands[failedIndex],
    stderr: result.stderr,
    code: result.code,
    disconnected: result.code === null,
  };
};
