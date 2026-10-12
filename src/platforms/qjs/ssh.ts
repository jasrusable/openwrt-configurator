import * as std from "std";
import { hostKeyAlgorithms, hostKeyChangedMessage, pinnedKeyChangedMessage } from "../../knownHosts";
import { dirname } from "../../paths";
import { ExecResult, Session, SshTarget } from "../../platform";
import { mkdirp, removeFile } from "./files";
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
  /** What the session leaves behind (a pinned key's file), removed when it is closed. */
  cleanup?: () => void;
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

const sessionOver = ({ exec, cleanup }: Transport, local = false): Session => ({
  execCommand: (command, options) => exec(command, { stdin: options?.stdin }),
  // Every command is its own client process: only files of its own to remove.
  dispose: () => cleanup?.(),
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

/** A known_hosts holding only the pinned key, for OpenSSH to check strictly. */
const pinnedKnownHosts = (host: string, key: { type: string; key: string }) => {
  const path = tmpPath("pinned-host");
  const created = spawnSync(["sh", "-c", 'umask 077 && cat > "$1"', "sh", path], `${host} ${key.type} ${key.key}\n`);
  if (created.code !== 0) throw new Error(`Could not pin the host key: ${created.stderr}`);
  return path;
};

const openSsh = (target: SshTarget, host: string): Transport => {
  const seconds = (ms: number) => String(Math.max(1, Math.round(ms / 1000)));
  const pinned = target.hostKey && pinnedKnownHosts(host, target.hostKey);
  const options = [
    "-T",
    // A pinned key: exactly it, from a file of its own, never recorded.
    // Otherwise trust on first use, sharing the Node platform's file;
    // unhashed so that it can read the entries too.
    ...(target.hostKey
      ? [
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${pinned}`,
          "-o",
          // An RSA key is checked with SHA-2 signatures, as ssh2 does, not ssh-rsa's SHA-1 alone.
          `HostKeyAlgorithms=${hostKeyAlgorithms(target.hostKey.type).join(",")}`,
        ]
      : target.knownHostsFile
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
  return {
    ...transport((command) => ["ssh", ...options, host, command], env),
    ...(pinned
      ? {
          cleanup: () => {
            try {
              removeFile(pinned);
            } catch {
              // Already gone.
            }
          },
        }
      : {}),
  };
};

/**
 * A home of its own for dbclient, whose only known host is the pinned key:
 * dbclient reads $HOME/.ssh/known_hosts and has no option for another file,
 * and without -y it refuses any other key (verified on 25.12.5: the match
 * connects, a different key is refused, the real known_hosts is untouched).
 */
const pinnedHome = (host: string, key: { type: string; key: string }) => {
  const home = tmpPath("pinned-home");
  const created = spawnSync(
    ["sh", "-c", 'umask 077 && mkdir -p "$1/.ssh" && cat > "$1/.ssh/known_hosts"', "sh", home],
    `${host} ${key.type} ${key.key}\n`
  );
  if (created.code !== 0) throw new Error(`Could not pin the host key: ${created.stderr}`);
  return home;
};

const dropbear = (target: SshTarget, host: string): Transport => {
  const home = target.hostKey && pinnedHome(host, target.hostKey);
  const options = [
    // Pinned: no -y, so only the key in its own home is accepted. Otherwise
    // a single -y accepts an unknown host key and records it in dbclient's
    // own ~/.ssh/known_hosts, but still refuses a changed one.
    ...(home ? [] : ["-y"]),
    "-K",
    String(Math.max(1, Math.round(target.keepaliveInterval / 1000))),
    ...(target.privateKeyPath ? ["-i", target.privateKeyPath] : []),
    ...(target.username ? ["-l", target.username] : []),
  ];
  const env = environment({ DROPBEAR_PASSWORD: target.password, ...(home ? { HOME: home } : {}) });
  const plain = transport((command) => ["dbclient", ...options, host, command], env);
  // A server offering a key of another type than the pinned one is "not in
  // the trusted hosts file": dbclient then asks, and with no terminal (CGI)
  // reads the answer from stdin, where a command's input would be taken for
  // it. So stdin always starts with "n", which refuses; when dbclient does
  // not ask, the far side drops that one byte before the command reads.
  const pinned: Transport["exec"] = (command, options) =>
    plain.exec(`dd bs=1 count=1 >/dev/null 2>&1; ${command}`, { ...options, stdin: `n${options?.stdin ?? ""}` });
  return {
    exec: home ? pinned : plain.exec,
    ...(home
      ? {
          cleanup: () => {
            spawnSync(["rm", "-rf", home]);
          },
        }
      : {}),
  };
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
    if (target.hostKey && /HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Host key mismatch|remove the bad entry/i.test(detail)) {
      client.cleanup?.();
      throw new Error(pinnedKeyChangedMessage(host));
    }
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
    client.cleanup?.();
    throw new Error(`SSH to ${host} failed: ${detail}${hint}`);
  }
  return sessionOver(client);
};
