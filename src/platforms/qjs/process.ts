import * as std from "std";
import { ExecResult } from "../../platform";
import { fileExists, os, sleep } from "./runtime";

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
export const tmpPath = (label: string) =>
  `${tmpDir()}/${label}-${Math.random().toString(36).slice(2, 10)}`;

export const removeTmpDir = () => {
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

export const which = (name: string) => {
  if (name.includes("/")) return fileExists(name) ? name : undefined;
  return (std.getenv("PATH") || "/usr/sbin:/usr/bin:/sbin:/bin")
    .split(":")
    .map((dir) => `${dir}/${name}`)
    .find(fileExists);
};

export const resolveArgv = (argv: string[]) => {
  const program = which(argv[0]);
  if (!program) throw new Error(`${argv[0]}: command not found`);
  return [program, ...argv.slice(1)];
};

export const environment = (
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
 * stdin, stdout and stderr as temporary files rather than pipes, so a large
 * input and a large output can never deadlock against each other.
 */
const openStdio = (stdin?: string) => {
  const input = tmpFileWith(stdin);
  const out = tmpFileWith();
  const err = tmpFileWith();
  return {
    fds: {
      stdin: input.fileno(),
      stdout: out.fileno(),
      stderr: err.fileno(),
    },
    result: (code: number | null): ExecResult => ({
      stdout: readAll(out),
      stderr: readAll(err),
      code,
    }),
    close: () => {
      input.close();
      out.close();
      err.close();
    },
  };
};

/** Run a program to completion without blocking the event loop. */
export const spawn = async (
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
  const command = resolveArgv(argv);
  const stdio = openStdio(stdin);
  try {
    const pid = os.exec(command, {
      block: false,
      usePath: false,
      env,
      ...stdio.fds,
    });
    const started = Date.now();
    let killedAt: number | undefined;
    let delay = 2;
    for (;;) {
      const [done, status] = os.waitpid(pid, os.WNOHANG);
      if (done === pid) {
        return { ...stdio.result(exitCode(status)), timedOut: !!killedAt };
      }
      if (
        !killedAt &&
        timeoutMs !== undefined &&
        Date.now() - started > timeoutMs
      ) {
        os.kill(pid, os.SIGTERM);
        killedAt = Date.now();
      } else if (killedAt && Date.now() - killedAt > 5000) {
        os.kill(pid, 9);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 50);
    }
  } finally {
    stdio.close();
  }
};

/**
 * Started and left running, in a session of its own where there is setsid
 * (OpenWrt's busybox, which runs the program in place rather than forking,
 * as it is not a process group leader: so the pid returned is the program's,
 * verified on 25.12.5), its output to `log`. Never a shell between, which
 * could exec away the arguments that say what the program is.
 */
export const spawnDetached = (argv: string[], { log }: { log: string }) => {
  const out = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600);
  if (out < 0) throw new Error(`${log}: could not write it`);
  const none = os.open("/dev/null", os.O_RDONLY);
  try {
    const setsid = which("setsid");
    const pid = os.exec([...(setsid ? [setsid] : []), ...resolveArgv(argv)], {
      block: false,
      usePath: false,
      stdin: none,
      stdout: out,
      stderr: out,
    });
    if (pid < 0) throw new Error(`${argv[0]}: could not be started`);
    return pid;
  } finally {
    os.close(out);
    if (none >= 0) os.close(none);
  }
};

/** Synchronous variant, for the few interface methods that are synchronous. */
export const spawnSync = (argv: string[], stdin?: string): ExecResult => {
  const command = resolveArgv(argv);
  const stdio = openStdio(stdin);
  try {
    return stdio.result(
      os.exec(command, { block: true, usePath: false, ...stdio.fds })
    );
  } finally {
    stdio.close();
  }
};
