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
};

/** A shell on a device. Shaped like node-ssh's `NodeSSH`, which satisfies it. */
export type Session = {
  execCommand: (
    command: string,
    options?: { stdin?: string }
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
   */
  knownHostsFile?: string;
  /** Handshake timeout. */
  readyTimeout: number;
  keepaliveInterval: number;
  keepaliveCountMax: number;
};

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
  mkdirp: (path: string) => void;
  /** Permission bits (e.g. 0o600), or undefined when the file does not exist. */
  fileMode: (path: string) => number | undefined;
  /** No-op when the file does not exist. */
  removeFile: (path: string) => void;
  readFileHead: (path: string, bytes: number) => Uint8Array;
  sha256: (text: string) => string;
  sha256File: (path: string) => Promise<string>;

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

  /** Run a local program. Rejects only if it could not be started. */
  run: (argv: string[], options?: { stdin?: string }) => Promise<ExecResult>;
  /** Run a local program attached to this terminal; resolves its exit code. */
  runInteractive: (argv: string[]) => Promise<number | null>;

  connect: (target: SshTarget) => Promise<Session>;
};
