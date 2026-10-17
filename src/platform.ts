/**
 * Everything the tool needs from the runtime it is running on.
 *
 * The rest of `src/` must not import Node built-ins or Node-only packages, so
 * the same bundle can run under Node on a workstation and under QuickJS on an
 * OpenWrt device. Each entry point builds one implementation (see
 * `src/platforms/`) and passes it down explicitly; functions take only the
 * parts they use, typed as `Pick<Platform, ...>`, so tests can hand in fakes.
 */

export type ExecResult = {
  stdout: string;
  stderr: string;
  /** `null` when the command never reported an exit status (e.g. the link dropped). */
  code: number | null;
  /** Ended because it ran past its time limit (then `code` is null too). */
  timedOut?: boolean;
};

/**
 * How long a command on a device may run unless it says otherwise. A link
 * can stall without dropping (an SSH client waiting on a session the device
 * never serves): every command ends by this, its client killed, rather than
 * holding a run forever.
 */
export const commandTimeoutMs = 120_000;

/** A shell on a device. */
export type Session = {
  /** Ends the command (its client killed or the link closed) after `timeoutMs`, else `commandTimeoutMs`. */
  execCommand: (
    command: string,
    options?: { stdin?: string; timeoutMs?: number }
  ) => Promise<ExecResult>;
  dispose: () => void;
  /** Commands run on this machine itself, not over SSH (a device provisioning itself). */
  local?: boolean;
};

export type SshTarget = {
  host?: string;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  agent?: string;
  /**
   * Trust-on-first-use store (OpenSSH known_hosts format): a host's key is
   * recorded on first connect and a different key is refused afterwards.
   * Exactly this file, on every client: never the user's own ~/.ssh one. With
   * neither it nor `hostKey`, connecting is refused, never any key accepted.
   */
  knownHostsFile?: string;
  /**
   * The key this host must present: any other is refused, and the
   * known_hosts file is neither read nor written. For an address the app
   * found itself, which anyone could have claimed (src/locate.ts). A client
   * that cannot check a given key must refuse to connect.
   */
  hostKey?: { type: string; key: string };
  /** Handshake timeout. */
  readyTimeout: number;
  keepaliveInterval: number;
  keepaliveCountMax: number;
};

/** An incoming request, as both the HTTP server and CGI see it. */
export type HttpRequest = {
  method: string;
  /** Without the query string. */
  path: string;
  body: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  /** The client's address, where the server knows it: for limits per client. */
  remoteAddress?: string;
  /** It came over HTTPS (a router's uhttpd with TLS): its cookies may say Secure. */
  secure?: boolean;
};

/** How a request is answered: a server, or CGI on the router. */
export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse>;

export type HttpResponse = {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
};

/**
 * Rejected for a network-level failure, never for an HTTP status: `request`
 * resolves with whatever status the server sent.
 */
export type NetworkError = Error & { transient: boolean };

export type Platform = {
  /** e.g. "darwin", "linux". */
  os: string;
  env: (name: string) => string | undefined;
  homedir: () => string;
  sleep: (ms: number) => Promise<void>;
  exit: (code: number) => never;

  readTextFile: (path: string) => string;
  writeTextFile: (path: string, data: string) => void;
  /** Adds to the end, making the file if needed: one write, never the whole file again. */
  appendTextFile: (path: string, data: string) => void;
  /**
   * Makes the directory and any missing parents. With a mode, those it makes
   * get it, and the directory itself is set to it if it already exists (an
   * old one tightened); parents that existed are left as they are.
   */
  mkdirp: (path: string, mode?: number) => void;
  /** Permission bits (e.g. 0o600), or undefined when the file does not exist. */
  fileMode: (path: string) => number | undefined;
  /** No-op when the file does not exist. */
  removeFile: (path: string) => void;
  /** The names in a directory (not "." or ".."); none when it does not exist. */
  listDir: (path: string) => string[];
  /** Make one directory, owner-only; false when it already exists (atomic: what a lock is). */
  makeDir: (path: string) => boolean;
  /**
   * A directory for this program's user alone, made owner-only, or one that
   * already is: a real directory (not a symlink), this user's, mode 700. Any
   * other is refused (throws): in /tmp anyone may take a name first, and
   * root writing through what they left would be an arbitrary write.
   */
  privateDir: (path: string) => void;
  /** A directory and everything in it gone; no-op when it does not exist. */
  removeDir: (path: string) => void;
  /** When a file or directory last changed, ms since the epoch; undefined when it does not exist. */
  modifiedAt: (path: string) => number | undefined;
  readFileHead: (path: string, bytes: number) => Uint8Array;
  sha256: (text: string) => string;
  sha256File: (path: string) => Promise<string>;

  /** A request ends by `httpTimeoutMs`; a download (an image, minutes on a slow line) once it stalls: a collector must never hang on one. */
  http: {
    request: (req: {
      method: "GET" | "POST";
      url: string;
      json?: unknown;
    }) => Promise<HttpResponse>;
    /** Rejects on a non-2xx status. */
    download: (
      url: string,
      path: string
    ) => Promise<{ bytes: number; contentLength?: number }>;
  };

  /**
   * Run a local program. Rejects only if it could not be started. With a
   * time limit, it runs in a session of its own (no terminal to prompt on),
   * and past it, it and whatever it started are killed (`timedOut`).
   */
  run: (argv: string[], options?: { stdin?: string; timeoutMs?: number }) => Promise<ExecResult>;
  /** Run a local program attached to this terminal; resolves its exit code. */
  runInteractive: (argv: string[]) => Promise<number | null>;
  /**
   * Start a program that outlives this process, in a session of its own (a
   * web server ending the request that started it must not end it), its
   * output to `log`. Returns its pid: the program itself, never a shell
   * between, so its command line says what it is (commandLineOf).
   */
  spawnDetached: (argv: string[], options: { log: string }) => number;
  /** A running process's command line, its arguments joined by spaces; undefined when no process has that pid. */
  commandLineOf: (pid: number) => Promise<string | undefined>;
  /** Call `handler` when this process is asked to stop (SIGTERM, SIGINT, SIGHUP); then it exits as killed. */
  onStop: (handler: (signal: string) => void) => void;

  connect: (target: SshTarget) => Promise<Session>;

  /**
   * Replace a file in one step (write a temporary file, then rename it), so a
   * crash mid-write leaves the old file whole.
   */
  writeFileAtomic: (path: string, data: string, mode: number) => void;
  /**
   * The command that runs this program again (before its arguments), for
   * work that must outlive a request, like a provision started from the UI.
   */
  selfCommand: () => string[];
  /** All of standard input: a CGI request's body. */
  readStdin: () => string;
  /**
   * Answer HTTP on a port until the process is killed. Node only: QuickJS
   * cannot listen on a socket, so on a router uhttpd runs `cgi` instead.
   */
  serve?: (
    handler: HttpHandler,
    options: { host: string; port: number }
  ) => Promise<void>;
};

/** How long an HTTP request may take, and a download may stall. */
export const httpTimeoutMs = 60_000;

/** What `serve` listens on: this machine only (it has no login). */
export const loopbackHosts = ["127.0.0.1", "::1", "localhost"];

/**
 * Why a file operation failed, the same on both platforms: the errno's name,
 * carried as `code` on the error each throws, for these.
 */
export type FileErrorCode = "ENOENT" | "EACCES" | "EISDIR" | "ENOTDIR";
export const fileErrorCode = (thrown: unknown): FileErrorCode | undefined => {
  const code = (thrown as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EISDIR" || code === "ENOTDIR" ? code : undefined;
};
