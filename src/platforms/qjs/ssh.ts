import { hostKeyAlgorithms, hostKeyChangedMessage, parseKnownHosts, pinnedKeyChangedMessage } from "../../knownHosts";
import { dirname } from "../../posixPath";
import { commandTimeoutMs, ExecResult, Session, SshTarget } from "../../platform";
import { fileExists, mkdirp, readTextFile, removeFile } from "./files";
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
  // Killed for running too long: whatever it printed, it never finished.
  if (result.timedOut) return { stdout: result.stdout, stderr: result.stderr, code: null, timedOut: true };
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
  env: Record<string, string>,
  group = false
): Transport => ({
  exec: async (command, options) =>
    unwrapResult(await spawn(clientArgv(wrapCommand(command)), { env, group, ...options })),
});

const sessionOver = ({ exec, cleanup }: Transport, local = false): Session => ({
  execCommand: (command, options) =>
    exec(command, { stdin: options?.stdin, timeoutMs: options?.timeoutMs ?? commandTimeoutMs }),
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

type HostKey = { type: string; key: string };

/**
 * The keys `host` is held to: the pinned one, else those on record in the
 * caller's file. A host known by some key types is held to them, as the Node
 * platform holds it (knownHosts.ts checkHostKey): left to the client, a key
 * of a type not on record would be taken as new and trusted. None: trust on
 * first use.
 */
const keysFor = (host: string, target: SshTarget, knownHostsFile: string): HostKey[] =>
  target.hostKey
    ? [target.hostKey]
    : parseKnownHosts(fileExists(knownHostsFile) ? readTextFile(knownHostsFile) : "")
        .filter((k) => k.host === host)
        .map(({ type, key }) => ({ type, key }));

const knownHostsLines = (host: string, keys: HostKey[]) => keys.map((k) => `${host} ${k.type} ${k.key}\n`).join("");

/** A known_hosts holding only the keys held to, for OpenSSH to check strictly. */
const pinnedKnownHosts = (host: string, keys: HostKey[]) => {
  const path = tmpPath("pinned-host");
  const created = spawnSync(["sh", "-c", 'umask 077 && cat > "$1"', "sh", path], knownHostsLines(host, keys));
  if (created.code !== 0) throw new Error(`Could not pin the host key: ${created.stderr}`);
  return path;
};

const openSsh = (target: SshTarget, host: string, knownHostsFile: string): Transport => {
  const seconds = (ms: number) => String(Math.max(1, Math.round(ms / 1000)));
  const keys = keysFor(host, target, knownHostsFile);
  const pinned = keys.length > 0 ? pinnedKnownHosts(host, keys) : undefined;
  const options = [
    "-T",
    // Exactly the file meant, never the system's as well.
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    // A host already known: exactly its keys, from a file of their own,
    // never recorded. Otherwise trust on first use, sharing the Node
    // platform's file; unhashed so that it can read the entries too.
    ...(pinned
      ? [
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${pinned}`,
          "-o",
          // An RSA key is checked with SHA-2 signatures, as ssh2 does, not ssh-rsa's SHA-1 alone.
          `HostKeyAlgorithms=${[...new Set(keys.flatMap((k) => hostKeyAlgorithms(k.type)))].join(",")}`,
        ]
      : [
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${knownHostsFile}`,
          "-o",
          "HashKnownHosts=no",
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
          ...(target.privateKeyPath || target.agent ? [] : ["-o", "PubkeyAuthentication=no"]),
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
 * A home of its own for dbclient, which reads $HOME/.ssh/known_hosts and has
 * no option for another file: there, exactly the file the caller means, never
 * root's own. A host already known (a pinned key, or keys on record in the
 * caller's file): only its keys, copied, and no -y, so any other is refused
 * (verified on 25.12.5: the match connects, a different key is refused). A
 * host not yet known: a link to the caller's file, which a single -y adds the
 * key it shows to (trust on first use).
 */
const dbclientHome = (host: string, target: SshTarget, knownHostsFile: string) => {
  const keys = keysFor(host, target, knownHostsFile);
  const home = tmpPath("dbclient-home");
  const created =
    keys.length > 0
      ? spawnSync(
          ["sh", "-c", 'umask 077 && mkdir -p "$1/.ssh" && cat > "$1/.ssh/known_hosts"', "sh", home],
          knownHostsLines(host, keys)
        )
      : spawnSync(["sh", "-c", 'umask 077 && mkdir -p "$1/.ssh" && ln -s "$2" "$1/.ssh/known_hosts"', "sh", home, knownHostsFile]);
  if (created.code !== 0) throw new Error(`Could not set up dbclient's known hosts: ${created.stderr}`);
  return { home, strict: keys.length > 0 };
};

const dropbear = (target: SshTarget, host: string, knownHostsFile: string): Transport => {
  const { home, strict } = dbclientHome(host, target, knownHostsFile);
  const options = [
    ...(strict ? [] : ["-y"]),
    "-K",
    String(Math.max(1, Math.round(target.keepaliveInterval / 1000))),
    ...(target.privateKeyPath ? ["-i", target.privateKeyPath] : []),
    ...(target.username ? ["-l", target.username] : []),
  ];
  const env = environment({ DROPBEAR_PASSWORD: target.password, HOME: home });
  const plain = transport((command) => ["dbclient", ...options, host, command], env);
  // A server offering a key of another type than those known is "not in
  // the trusted hosts file": dbclient then asks, and with no terminal (CGI)
  // reads the answer from stdin, where a command's input would be taken for
  // it. So stdin always starts with "n", which refuses; when dbclient does
  // not ask, the far side drops that one byte before the command reads.
  const refusing: Transport["exec"] = (command, options) =>
    plain.exec(`dd bs=1 count=1 >/dev/null 2>&1; ${command}`, { ...options, stdin: `n${options?.stdin ?? ""}` });
  return {
    exec: strict ? refusing : plain.exec,
    cleanup: () => {
      spawnSync(["rm", "-rf", home]);
    },
  };
};

export const connect = async (target: SshTarget): Promise<Session> => {
  const host = target.host;
  if (!host) throw new Error("No host to connect to.");

  if (isLocal(host)) {
    // A group of its own: a command past its time limit is killed with
    // whatever it started, not the outer shell alone.
    return sessionOver(
      transport((command) => ["sh", "-c", command], environment(), true),
      true
    );
  }

  // Never any key accepted: there is always a file, or a key, to check it against.
  const knownHostsFile = target.knownHostsFile;
  if (!knownHostsFile && !target.hostKey) throw new Error(`SSH to ${host} refused: no known_hosts file and no host key to check it against.`);
  const file = knownHostsFile ?? "/dev/null";
  if (knownHostsFile) mkdirp(dirname(knownHostsFile));

  // On OpenWrt, `ssh` may be dropbear's client under another name; use
  // dbclient explicitly when present, since its flags differ from OpenSSH's.
  const client = which("dbclient") ? dropbear(target, host, file) : openSsh(target, host, file);

  // Like node-ssh, fail at connect time rather than on the first command.
  // dbclient has no connect timeout of its own, so this one bounds it.
  const probe = await client.exec("true", { timeoutMs: target.readyTimeout });
  if (probe.code !== 0) {
    client.cleanup?.();
    const detail = probe.stderr.trim() || "no response";
    // OpenSSH and dbclient each announce a changed key in their own words.
    const changed = /HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Host key mismatch|remove the bad entry|Didn't validate host key/i.test(detail);
    if (changed) throw new Error(target.hostKey ? pinnedKeyChangedMessage(host) : hostKeyChangedMessage(host, file));
    const hint =
      target.password && /Remote closed the connection/.test(detail)
        ? " (dropbear closes the connection after repeated bad passwords)"
        : "";
    throw new Error(`SSH to ${host} failed: ${detail}${hint}`);
  }
  return sessionOver(client);
};
