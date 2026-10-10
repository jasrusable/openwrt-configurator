import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { NodeSSH } from "node-ssh";
import {
  checkHostKey,
  formatKnownHost,
  hostKeyAlgorithms,
  hostKeyChangedMessage,
  keyTypeOfBlob,
  parseKnownHosts,
} from "../knownHosts";
import { dirname } from "../paths";
import { NetworkError, Platform, SshTarget } from "../platform";

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
  return new Error(
    `${path}: ${(code && reasons[code]) ?? (e as Error)?.message ?? e}`
  );
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

const headersOf = (response: Response) => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
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
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  fileMode: (path) => {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return undefined;
    }
  },
  removeFile: (path) => rmSync(path, { force: true }),
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
        ? new Error(hostKeyChangedMessage(target.host!, target.knownHostsFile!))
        : e;
    }
    // Once a command is in flight node-ssh drops its own 'error' listener, so an
    // RST arriving mid-command would emit 'error' with nothing attached and kill
    // the process. The command still settles via the channel closing.
    ssh.connection?.on("error", () => {});
    return ssh;
  },
};
