import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createServer } from "http";
import { homedir } from "os";
import { NodeSSH } from "node-ssh";
import {
  checkHostKey,
  formatKnownHost,
  hostKeyAlgorithms,
  hostKeyChangedMessage,
  pinnedKeyChangedMessage,
  keyTypeOfBlob,
  parseKnownHosts,
} from "../knownHosts";
import { dirname } from "../posixPath";
import { commandTimeoutMs, ExecResult, loopbackHosts, NetworkError, Platform, Session, SshTarget } from "../platform";

const transientCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// fetch rejects with a bare "fetch failed" TypeError; the useful code is on
// its cause.
const networkError = (e: unknown, url: string): NetworkError => {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return Object.assign(
    new Error(`${url}: ${code ?? (e as Error)?.message ?? e}`),
    { transient: code !== undefined && transientCodes.has(code) }
  );
};

// The same wording QuickJS's strerror gives, so a missing config file reads
// the same on both platforms.
const reasons: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
};
const fileError = (path: string, e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return Object.assign(new Error(`${path}: ${(code && reasons[code]) ?? (e as Error)?.message ?? e}`), {
    ...(code && code in reasons ? { code } : {}),
  });
};
const withPath = <T>(path: string, fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw fileError(path, e);
  }
};

/**
 * ssh2 options that verify the host key against `knownHostsFile`, recording
 * it the first time. Once a host's key type is known, only that type is
 * negotiated, so a server cannot dodge the check by offering another.
 */
const hostKeyOptions = (target: SshTarget, onChanged: () => void) => {
  const pinned = target.hostKey;
  if (pinned) {
    // Exactly this key, of this type only; the shared file is not involved.
    return {
      algorithms: { serverHostKey: hostKeyAlgorithms(pinned.type) },
      hostVerifier: (key: Buffer) => {
        const ok = keyTypeOfBlob(key) === pinned.type && key.toString("base64") === pinned.key;
        if (!ok) onChanged();
        return ok;
      },
    };
  }
  const file = target.knownHostsFile;
  const host = target.host;
  if (!file || !host) return {};
  const entries = existsSync(file)
    ? parseKnownHosts(readFileSync(file, "utf-8"))
    : [];
  const knownTypes = entries
    .filter((entry) => entry.host === host)
    .map((entry) => entry.type);
  return {
    ...(knownTypes.length > 0
      ? {
          algorithms: {
            serverHostKey: [...new Set(knownTypes.flatMap(hostKeyAlgorithms))],
          },
        }
      : {}),
    hostVerifier: (key: Buffer) => {
      const candidate = {
        host,
        type: keyTypeOfBlob(key),
        key: key.toString("base64"),
      };
      const verdict = checkHostKey(entries, candidate);
      if (verdict === "new") {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, formatKnownHost(candidate));
      }
      if (verdict === "changed") onChanged();
      return verdict !== "changed";
    },
  };
};

/**
 * node-ssh's session with each command's time limit: one that runs past it
 * ends the connection (a stalled channel cannot be told apart from a stalled
 * link), answers `timedOut`, and the session is not used again.
 */
export const limitedSession = (ssh: Pick<NodeSSH, "execCommand" | "dispose">): Session => ({
  execCommand: (command, options) =>
    new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        ssh.dispose();
        resolve({ stdout: "", stderr: "", code: null, timedOut: true });
      }, options?.timeoutMs ?? commandTimeoutMs);
      ssh
        .execCommand(command, options?.stdin === undefined ? {} : { stdin: options.stdin })
        .then(
          (result) => resolve(result),
          // A link that went: no exit status, as a dropped channel reports.
          (e) => resolve({ stdout: "", stderr: String((e as Error)?.message ?? e), code: null })
        )
        .finally(() => clearTimeout(timer));
    }),
  dispose: () => ssh.dispose(),
});

const headersOf = (response: Response) => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
};

/**
 * Writes to stdout and stderr finish before the next line runs, even into a
 * pipe: `exit` (process.exit) otherwise drops what a pipe has not taken yet,
 * cutting `compile | jq` off at 64 KiB. Writes to a file or a terminal are
 * already synchronous. Called by the CLI's entry point, before any output.
 */
export const blockingStdio = () => {
  for (const stream of [process.stdout, process.stderr]) {
    (stream as { _handle?: { setBlocking?: (blocking: boolean) => void } })._handle?.setBlocking?.(true);
  }
};

export const nodePlatform: Platform = {
  os: process.platform,
  env: (name) => process.env[name],
  homedir,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exit: (code) => process.exit(code),

  readTextFile: (path) => withPath(path, () => readFileSync(path, "utf-8")),
  writeTextFile: (path, data) =>
    withPath(path, () => writeFileSync(path, data)),
  appendTextFile: (path, data) =>
    withPath(path, () => appendFileSync(path, data)),
  mkdirp: (path, mode) => {
    mkdirSync(path, { recursive: true, ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
  },
  fileMode: (path) => {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return undefined;
    }
  },
  removeFile: (path) => rmSync(path, { force: true }),
  listDir: (path) => {
    try {
      return readdirSync(path).sort();
    } catch {
      return [];
    }
  },
  makeDir: (path) => {
    try {
      mkdirSync(path, { mode: 0o700 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw fileError(path, e);
    }
  },
  removeDir: (path) => rmSync(path, { recursive: true, force: true }),
  modifiedAt: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
  },
  readFileHead: (path, bytes) => {
    const head = Buffer.alloc(bytes);
    const fd = openSync(path, "r");
    try {
      return head.subarray(0, readSync(fd, head, 0, bytes, 0));
    } finally {
      closeSync(fd);
    }
  },
  sha256: (text) => createHash("sha256").update(text).digest("hex"),
  sha256File: (path) =>
    new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(path)
        .on("data", (chunk) => hash.update(chunk))
        .on("end", () => resolve(hash.digest("hex")))
        .on("error", reject);
    }),

  http: {
    request: async ({ method, url, json }) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          ...(json === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(json),
              }),
        });
      } catch (e) {
        throw networkError(e, url);
      }
      return {
        status: response.status,
        headers: headersOf(response),
        body: await response.text(),
      };
    },
    download: async (url, path) => {
      let response: Response;
      try {
        response = await fetch(url);
      } catch (e) {
        throw networkError(e, url);
      }
      if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
      }
      const body = Buffer.from(await response.arrayBuffer());
      writeFileSync(path, body);
      const declared = response.headers.get("content-length");
      return {
        bytes: body.length,
        contentLength: declared ? parseInt(declared, 10) : undefined,
      };
    },
  },

  run: (argv, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code }));
      // A program that exits without reading its input (`ip route`, say)
      // closes the pipe first, and the write then fails with EPIPE. That is
      // not an error worth crashing over: the exit status says what happened.
      child.stdin.on("error", () => {});
      child.stdin.end(options?.stdin ?? "");
    }),
  runInteractive: (argv) =>
    new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    }),
  spawnDetached: (argv, { log }) => {
    const out = openSync(log, "w", 0o600);
    try {
      // detached: a session of its own (setsid), so neither the server
      // stopping nor its terminal's Ctrl-C ends the run.
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", out, out] });
      if (child.pid === undefined) throw new Error(`${argv[0]}: could not be started`);
      child.unref();
      return child.pid;
    } finally {
      closeSync(out);
    }
  },
  commandLineOf: async (pid) => {
    if (existsSync("/proc/self")) {
      try {
        const line = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        // An exited child not yet reaped has an empty one: not running.
        return line || undefined;
      } catch {
        return undefined;
      }
    }
    // macOS: no /proc. ps exits non-zero for a pid with no process.
    const out = await nodePlatform.run(["ps", "-ww", "-p", String(pid), "-o", "command="]);
    return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : undefined;
  },
  onStop: (handler) => {
    const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
    for (const [signal, number] of Object.entries(signals)) {
      process.once(signal, () => {
        handler(signal);
        process.exit(128 + number);
      });
    }
  },

  connect: async (target) => {
    const ssh = new NodeSSH();
    let changed = false;
    try {
      await ssh.connect({
        ...target,
        ...hostKeyOptions(target, () => (changed = true)),
      });
    } catch (e) {
      throw changed
        ? new Error(
            target.hostKey
              ? pinnedKeyChangedMessage(target.host!)
              : hostKeyChangedMessage(target.host!, target.knownHostsFile!)
          )
        : e;
    }
    // Once a command is in flight node-ssh drops its own 'error' listener, so an
    // RST arriving mid-command would emit 'error' with nothing attached and kill
    // the process. The command still settles via the channel closing.
    ssh.connection?.on("error", () => {});
    return limitedSession(ssh);
  },

  writeFileAtomic: (path, data, mode) =>
    withPath(path, () => {
      // A name of its own: writers in several processes (the server, a job,
      // the collector) never share one. Made new, with its mode from the
      // start (writeFileSync sets a mode only on creation).
      const temporary = `${path}.onc-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      try {
        writeFileSync(temporary, data, { mode, flag: "wx" });
        chmodSync(temporary, mode);
        renameSync(temporary, path);
      } catch (e) {
        rmSync(temporary, { force: true });
        throw e;
      }
    }),
  readStdin: () => readFileSync(0, "utf8"),
  selfCommand: () => {
    const script = process.argv[1];
    // A pkg binary is self-contained; under ts-node (development) the
    // script is TypeScript, so the child needs ts-node too.
    if ((process as { pkg?: unknown }).pkg) return [process.execPath];
    return script.endsWith(".ts")
      ? [process.execPath, "-r", "ts-node/register/transpile-only", script]
      : [process.execPath, script];
  },
  serve: (handler, { host, port }) =>
    new Promise((_, reject) => {
      // DNS rebinding: a web page whose name now resolves to 127.0.0.1 is
      // same-origin with this server, so only answer requests addressed to
      // it by a local name, and refuse writes from any other origin.
      const allowedHosts = new Set(
        ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${port}`)
      );
      if (!loopbackHosts.includes(host)) {
        reject(new Error(`${host}: only a loopback address is served`));
        return;
      }
      const server = createServer((req, res) => {
        const origin = req.headers.origin;
        const crossOrigin =
          origin !== undefined &&
          ![...allowedHosts].some((h) => origin === `http://${h}`);
        if (
          !allowedHosts.has(req.headers.host ?? "") ||
          (req.method !== "GET" && crossOrigin)
        ) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("Forbidden");
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          const response = await handler({
            method: req.method ?? "GET",
            path: (req.url ?? "/").split("?")[0],
            body,
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([k, v]) => [k, String(v)])
            ),
            ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
          }).catch((e) => ({
            status: 500,
            headers: { "content-type": "text/plain" },
            body: String((e as Error)?.message ?? e),
          }));
          res.writeHead(response.status, response.headers);
          res.end(response.body);
        });
      });
      server.on("error", reject);
      server.listen(port, host);
    }),
};
