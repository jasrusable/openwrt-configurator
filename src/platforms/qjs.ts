import * as osModule from "os";
import * as std from "std";
import {
  ExecResult,
  NetworkError,
  Platform,
  Session,
  SshTarget,
} from "../platform";

const os = osModule as unknown as QuickJsOs;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => os.setTimeout(resolve, ms));

let privateDir: string | undefined;
/**
 * A directory only this process can use, for the few temp files that need a
 * name (curl's header and body output, the askpass helper). mkdir fails if the
 * name exists, so a planted file or symlink cannot be reused; on a router this
 * runs as root, where following one would be an arbitrary write.
 */
const tmpDir = () => {
  while (!privateDir) {
    const base = (std.getenv("TMPDIR") || "/tmp").replace(/\/$/, "");
    const candidate = `${base}/onc-${Math.random().toString(36).slice(2, 12)}`;
    if (os.mkdir(candidate, 0o700) === 0) privateDir = candidate;
  }
  return privateDir;
};
const tmpPath = (label: string) =>
  `${tmpDir()}/${label}-${Math.random().toString(36).slice(2, 10)}`;

const removeTmpDir = () => {
  if (!privateDir) return;
  spawnSync(["rm", "-rf", privateDir]);
  privateDir = undefined;
};

const tmpFileWith = (text = "") => {
  const file = std.tmpfile();
  if (!file) throw new Error("Could not create a temporary file.");
  if (text) {
    file.puts(text);
    file.flush();
    file.seek(0, std.SEEK_SET);
  }
  return file;
};

const readAll = (file: std.FILE) => {
  file.seek(0, std.SEEK_SET);
  return file.readAsString();
};

/** Wait status → exit code, or null if the process was killed by a signal. */
const exitCode = (status: number) =>
  (status & 0x7f) === 0 ? (status >> 8) & 0xff : null;

const fileExists = (path: string) => os.stat(path)[0] !== null;

const which = (name: string) => {
  if (name.includes("/")) return fileExists(name) ? name : undefined;
  return (std.getenv("PATH") || "/usr/sbin:/usr/bin:/sbin:/bin")
    .split(":")
    .map((dir) => `${dir}/${name}`)
    .find(fileExists);
};

const environment = (
  overrides: Record<string, string | undefined> = {}
): Record<string, string> => {
  const env: Record<string, string> = { ...std.getenviron() };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
};

/**
 * Run a program to completion without blocking the event loop. Output goes to
 * temporary files rather than pipes, so a large stdin and a large stdout can
 * never deadlock against each other.
 */
const spawn = async (
  argv: string[],
  {
    stdin,
    env,
    timeoutMs,
  }: {
    stdin?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<ExecResult & { timedOut: boolean }> => {
  const program = which(argv[0]);
  if (!program) throw new Error(`${argv[0]}: command not found`);
  const input = tmpFileWith(stdin);
  const out = tmpFileWith();
  const err = tmpFileWith();
  try {
    const pid = os.exec([program, ...argv.slice(1)], {
      block: false,
      usePath: false,
      stdin: input.fileno(),
      stdout: out.fileno(),
      stderr: err.fileno(),
      env,
    });
    const started = Date.now();
    let timedOut = false;
    let killedAt = 0;
    let delay = 2;
    for (;;) {
      const [done, status] = os.waitpid(pid, os.WNOHANG);
      if (done === pid) {
        return {
          stdout: readAll(out),
          stderr: readAll(err),
          code: exitCode(status),
          timedOut,
        };
      }
      const elapsed = Date.now() - started;
      if (timeoutMs !== undefined && !timedOut && elapsed > timeoutMs) {
        os.kill(pid, os.SIGTERM);
        timedOut = true;
        killedAt = Date.now();
      } else if (timedOut && Date.now() - killedAt > 5000) {
        os.kill(pid, 9);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 50);
    }
  } finally {
    input.close();
    out.close();
    err.close();
  }
};

/** Synchronous variant for the few interface methods that are synchronous. */
const spawnSync = (argv: string[], stdin?: string): ExecResult => {
  const program = which(argv[0]);
  if (!program) throw new Error(`${argv[0]}: command not found`);
  const input = tmpFileWith(stdin);
  const out = tmpFileWith();
  const err = tmpFileWith();
  try {
    const code = os.exec([program, ...argv.slice(1)], {
      block: true,
      usePath: false,
      stdin: input.fileno(),
      stdout: out.fileno(),
      stderr: err.fileno(),
    });
    return { stdout: readAll(out), stderr: readAll(err), code };
  } finally {
    input.close();
    out.close();
    err.close();
  }
};

const sha256Argv = () =>
  which("sha256sum")
    ? ["sha256sum"]
    : which("shasum")
    ? ["shasum", "-a", "256"]
    : undefined;

const sha256Of = (result: ExecResult) => {
  const hex = /^[0-9a-f]{64}/.exec(result.stdout)?.[0];
  if (result.code !== 0 || !hex) {
    throw new Error(`sha256 failed: ${result.stderr.trim()}`);
  }
  return hex;
};

const requireSha256 = () => {
  const argv = sha256Argv();
  if (!argv) throw new Error("Neither sha256sum nor shasum is available.");
  return argv;
};

// curl exit codes for failures worth retrying: DNS, connect, timeout, TLS
// handshake, empty reply, send/receive errors.
const transientCurlCodes = new Set([5, 6, 7, 28, 35, 52, 55, 56]);

const curl = async (args: string[], url: string, stdin?: string) => {
  if (!which("curl")) {
    throw new Error("HTTP requests need curl, which is not installed.");
  }
  const result = await spawn(["curl", "-sS", ...args, url], { stdin });
  if (result.code !== 0) {
    const error: NetworkError = Object.assign(
      new Error(
        `${url}: ${result.stderr.trim() || `curl exited ${result.code}`}`
      ),
      { transient: transientCurlCodes.has(result.code ?? -1) }
    );
    throw error;
  }
  return result;
};

/** Headers of the last response, after any redirects or 100-continue. */
const parseHeaders = (raw: string) => {
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const headers: Record<string, string> = {};
  for (const line of (blocks[blocks.length - 1] || "")
    .split(/\r?\n/)
    .slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
    }
  }
  return headers;
};

const readTextFile = (path: string) => {
  const errorObj: { errno?: number } = {};
  const file = std.open(path, "r", errorObj);
  if (!file) {
    throw new Error(`${path}: ${std.strerror(errorObj.errno ?? 0)}`);
  }
  try {
    return file.readAsString();
  } finally {
    file.close();
  }
};

const writeTextFile = (path: string, data: string) => {
  const errorObj: { errno?: number } = {};
  const file = std.open(path, "w", errorObj);
  if (!file) {
    throw new Error(`${path}: ${std.strerror(errorObj.errno ?? 0)}`);
  }
  try {
    file.puts(data);
  } finally {
    file.close();
  }
};

const removeFile = (path: string) => {
  os.remove(path);
};

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
    // Host keys are not verified, matching node-ssh, which accepts any key.
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
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
    // -y -y skips the host key check without writing known_hosts to flash.
    "-y",
    "-y",
    "-K",
    String(Math.max(1, Math.round(target.keepaliveInterval / 1000))),
    ...(target.privateKeyPath ? ["-i", target.privateKeyPath] : []),
    ...(target.username ? ["-l", target.username] : []),
  ];
  const env = environment({ DROPBEAR_PASSWORD: target.password });
  return transport((command) => ["dbclient", ...options, host, command], env);
};

const connect = async (target: SshTarget): Promise<Session> => {
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
  const client = which("dbclient")
    ? dropbear(target, host)
    : openSsh(target, host);

  // Like node-ssh, fail at connect time rather than on the first command.
  // dbclient has no connect timeout of its own, so this one bounds it.
  const probe = await client.exec("true", { timeoutMs: target.readyTimeout });
  if (probe.code !== 0) {
    const detail = probe.stderr.trim() || "no response";
    const hint =
      target.password && /Remote closed the connection/.test(detail)
        ? " (dropbear closes the connection after repeated bad passwords)"
        : "";
    throw new Error(`SSH to ${host} failed: ${detail}${hint}`);
  }
  return sessionOver(client);
};

// --- Platform ----------------------------------------------------------

export const qjsPlatform: Platform = {
  os: os.platform,
  env: (name) => std.getenv(name),
  homedir: () => std.getenv("HOME") || "/root",
  sleep,
  exit: (code) => {
    removeTmpDir();
    std.out.flush();
    std.err.flush();
    return std.exit(code);
  },

  readTextFile,
  writeTextFile,
  mkdirp: (path) => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (prefix && !fileExists(prefix)) {
        const result = os.mkdir(prefix, 0o777);
        if (result < 0 && !fileExists(prefix)) {
          throw new Error(`${prefix}: ${std.strerror(-result)}`);
        }
      }
    }
  },
  fileMode: (path) => {
    const [stat] = os.stat(path);
    return stat ? stat.mode & 0o777 : undefined;
  },
  removeFile,
  readFileHead: (path, bytes) => {
    const file = std.open(path, "rb");
    if (!file) throw new Error(`${path}: cannot open`);
    try {
      const buffer = new ArrayBuffer(bytes);
      const read = file.read(buffer, 0, bytes);
      return new Uint8Array(buffer, 0, read);
    } finally {
      file.close();
    }
  },
  sha256: (text) => sha256Of(spawnSync([...requireSha256(), "-"], text)),
  sha256File: async (path) => sha256Of(await spawn([...requireSha256(), path])),

  http: {
    request: async ({ method, url, json }) => {
      const headersPath = tmpPath("headers");
      const bodyPath = tmpPath("body");
      try {
        // The payload goes over stdin (an unlinked temp file), never a named
        // one: a build request carries the UCI-defaults script, secrets and all.
        const result = await curl(
          [
            "-X",
            method,
            "-D",
            headersPath,
            "-o",
            bodyPath,
            "-w",
            "%{http_code}",
            ...(json === undefined
              ? []
              : [
                  "-H",
                  "content-type: application/json",
                  "--data-binary",
                  "@-",
                ]),
          ],
          url,
          json === undefined ? undefined : JSON.stringify(json)
        );
        return {
          status: Number(result.stdout.trim()),
          headers: parseHeaders(readTextFile(headersPath)),
          body: fileExists(bodyPath) ? readTextFile(bodyPath) : "",
        };
      } finally {
        removeFile(headersPath);
        removeFile(bodyPath);
      }
    },
    download: async (url, path) => {
      const headersPath = tmpPath("headers");
      try {
        // -f: a non-2xx status fails rather than saving an error page.
        await curl(["-f", "-L", "-D", headersPath, "-o", path], url);
        const declared = parseHeaders(readTextFile(headersPath))[
          "content-length"
        ];
        const [stat] = os.stat(path);
        return {
          bytes: stat ? stat.size : 0,
          contentLength: declared ? parseInt(declared, 10) : undefined,
        };
      } finally {
        removeFile(headersPath);
      }
    },
  },

  run: async (argv, options) => {
    const { timedOut, ...result } = await spawn(argv, {
      stdin: options?.stdin,
    });
    return result;
  },
  runInteractive: async (argv) => {
    const program = which(argv[0]);
    if (!program) throw new Error(`${argv[0]}: command not found`);
    return os.exec([program, ...argv.slice(1)], {
      block: true,
      usePath: false,
    });
  },

  connect,
};
