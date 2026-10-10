import * as std from "std";
import { hostKeyChangedMessage } from "../../knownHosts";
import { dirname } from "../../paths";
import { ExecResult, Session, SshTarget } from "../../platform";
import { mkdirp } from "./files";
import { environment, spawn, spawnSync, tmpPath, which } from "./process";

// --- SSH ---------------------------------------------------------------

const EXIT_MARKER = "__ONC_EXIT__";

/**
 * Both OpenSSH and dropbear's client exit with the remote command's status,
 * but also use 255 (OpenSSH) or 1 (dbclient) for their own failures, so a
 * lost connection would look like a failing command. Report the status from
 * the remote side instead: no marker means the command never finished, which
 * is the `code: null` node-ssh gives for a dropped channel. The subshell keeps
 * an `exit` in the command from skipping the marker.
 */
const wrapCommand = (command: string) =>
  `(\n${command}\n)\nprintf '\\n${EXIT_MARKER}%s\\n' "$?" >&2`;

const unwrapResult = (result: ExecResult): ExecResult => {
  const match = new RegExp(`\\n?${EXIT_MARKER}(\\d+)\\n?$`).exec(result.stderr);
  return match
    ? {
        stdout: result.stdout,
        stderr: result.stderr.slice(0, match.index),
        code: Number(match[1]),
      }
    : { ...result, code: null };
};

type Transport = {
  exec: (
    command: string,
    options?: { stdin?: string; timeoutMs?: number }
  ) => Promise<ExecResult>;
};

const transport = (
  clientArgv: (command: string) => string[],
  env: Record<string, string>
): Transport => ({
  exec: async (command, options) =>
    unwrapResult(
      await spawn(clientArgv(wrapCommand(command)), { env, ...options })
    ),
});

const sessionOver = ({ exec }: Transport, local = false): Session => ({
  execCommand: (command, options) => exec(command, { stdin: options?.stdin }),
  // Every command is its own client process, so there is nothing to close.
  dispose: () => {},
  local,
});

const localAddresses = () => {
  if (!which("ip")) return [];
  const { stdout } = spawnSync(["ip", "-o", "addr", "show"]);
  return [...stdout.matchAll(/\binet6? ([^/\s]+)/g)].map((m) => m[1]);
};

const isLocal = (host: string) =>
  ["localhost", "127.0.0.1", "::1"].includes(host) ||
  localAddresses().includes(host);

let askpassPath: string | undefined;
/** A helper OpenSSH runs to read the password, so it never touches argv. */
const askpass = () => {
  if (!askpassPath) {
    askpassPath = tmpPath("askpass");
    const created = spawnSync(
      [
        "sh",
        "-c",
        'umask 077 && cat > "$1" && chmod 700 "$1"',
        "sh",
        askpassPath,
      ],
      `#!/bin/sh\nprintf '%s\\n' "$ONC_SSH_PASSWORD"\n`
    );
    if (created.code !== 0) {
      throw new Error(`Could not create askpass helper: ${created.stderr}`);
    }
  }
  return askpassPath;
};

const openSsh = (target: SshTarget, host: string): Transport => {
  const seconds = (ms: number) => String(Math.max(1, Math.round(ms / 1000)));
  const options = [
    "-T",
    // Trust on first use, sharing the Node platform's file; unhashed so that
    // it can read the entries too.
    ...(target.knownHostsFile
      ? [
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${target.knownHostsFile}`,
          "-o",
          "HashKnownHosts=no",
        ]
      : [
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
        ]),
    // Also hides the device's pre-auth banner, which would land in stderr.
    "-o",
    "LogLevel=ERROR",
    "-o",
    `ConnectTimeout=${seconds(target.readyTimeout)}`,
    "-o",
    `ServerAliveInterval=${seconds(target.keepaliveInterval)}`,
    "-o",
    `ServerAliveCountMax=${target.keepaliveCountMax}`,
    ...(target.privateKeyPath
      ? ["-i", target.privateKeyPath, "-o", "IdentitiesOnly=yes"]
      : []),
    ...(target.password
      ? [
          "-o",
          "NumberOfPasswordPrompts=1",
          ...(target.privateKeyPath ? [] : ["-o", "PubkeyAuthentication=no"]),
        ]
      : ["-o", "BatchMode=yes"]),
    ...(target.username ? ["-l", target.username] : []),
  ];
  const env = environment({
    SSH_AUTH_SOCK: target.agent,
    ...(target.password
      ? {
          SSH_ASKPASS: askpass(),
          SSH_ASKPASS_REQUIRE: "force",
          ONC_SSH_PASSWORD: target.password,
        }
      : {}),
  });
  return transport((command) => ["ssh", ...options, host, command], env);
};

const dropbear = (target: SshTarget, host: string): Transport => {
  const options = [
    // A single -y accepts an unknown host key and records it in dbclient's
    // own ~/.ssh/known_hosts, but still refuses a changed one.
    "-y",
    "-K",
    String(Math.max(1, Math.round(target.keepaliveInterval / 1000))),
    ...(target.privateKeyPath ? ["-i", target.privateKeyPath] : []),
    ...(target.username ? ["-l", target.username] : []),
  ];
  const env = environment({ DROPBEAR_PASSWORD: target.password });
  return transport((command) => ["dbclient", ...options, host, command], env);
};

export const connect = async (target: SshTarget): Promise<Session> => {
  const host = target.host;
  if (!host) throw new Error("No host to connect to.");

  if (isLocal(host)) {
    return sessionOver(
      transport((command) => ["sh", "-c", command], environment()),
      true
    );
  }

  // On OpenWrt, `ssh` may be dropbear's client under another name; use
  // dbclient explicitly when present, since its flags differ from OpenSSH's.
  const useDbclient = !!which("dbclient");
  if (!useDbclient && target.knownHostsFile) {
    mkdirp(dirname(target.knownHostsFile));
  }
  const client = useDbclient ? dropbear(target, host) : openSsh(target, host);

  // Like node-ssh, fail at connect time rather than on the first command.
  // dbclient has no connect timeout of its own, so this one bounds it.
  const probe = await client.exec("true", { timeoutMs: target.readyTimeout });
  if (probe.code !== 0) {
    const detail = probe.stderr.trim() || "no response";
    // OpenSSH and dbclient each announce a changed key in their own words.
    if (/HOST IDENTIFICATION HAS CHANGED|Host key mismatch/i.test(detail)) {
      throw new Error(
        hostKeyChangedMessage(
          host,
          useDbclient
            ? `${std.getenv("HOME") || "/root"}/.ssh/known_hosts`
            : target.knownHostsFile ?? "known_hosts"
        )
      );
    }
    const hint =
      target.password && /Remote closed the connection/.test(detail)
        ? " (dropbear closes the connection after repeated bad passwords)"
        : "";
    throw new Error(`SSH to ${host} failed: ${detail}${hint}`);
  }
  return sessionOver(client);
};
