import * as std from "std";
import { ExecResult, FileErrorCode } from "../../platform";
import { dirname } from "../../posixPath";
import { ownUid, spawn, spawnSync, which } from "./process";
import { fileExists, os } from "./runtime";

/** errno numbers (the same on Linux and macOS) by the names the platforms share (src/platform.ts). */
const errnoCodes: Record<number, FileErrorCode> = { 2: "ENOENT", 13: "EACCES", 20: "ENOTDIR", 21: "EISDIR" };

/** An error worded as Node's are (strerror), with the errno's name as its code. */
const fileError = (path: string, errno = 0) =>
  Object.assign(new Error(`${path}: ${std.strerror(errno)}`), errnoCodes[errno] ? { code: errnoCodes[errno] } : {});

export const readTextFile = (path: string) => {
  const errorObj: { errno?: number } = {};
  const file = std.open(path, "r", errorObj);
  if (!file) {
    throw fileError(path, errorObj.errno);
  }
  try {
    return file.readAsString();
  } finally {
    file.close();
  }
};

const writeWith = (how: "w" | "a") => (path: string, data: string) => {
  const errorObj: { errno?: number } = {};
  const file = std.open(path, how, errorObj);
  if (!file) {
    throw fileError(path, errorObj.errno);
  }
  try {
    file.puts(data);
  } finally {
    file.close();
  }
};

export const writeTextFile = writeWith("w");
export const appendTextFile = writeWith("a");

export const writeFileAtomic = (path: string, data: string, mode: number) => {
  // A name of its own (QuickJS has no getpid: chance does it, and O_EXCL
  // refuses a clash): writers in several processes (CGI requests, the
  // collector, a job) never share one. Made new, with its mode, before
  // anything is written to it: the data (a Wi-Fi password) is never in a
  // file others can read, even for a moment.
  const temporary = `${path}.onc-tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Written through the descriptor O_EXCL made, never the name opened again.
  const fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode);
  if (fd < 0) throw new Error(`${path}: could not write it`);
  const file = std.fdopen(fd, "w");
  if (!file) {
    os.close(fd);
    os.remove(temporary);
    throw new Error(`${path}: could not write it`);
  }
  try {
    try {
      file.puts(data);
    } finally {
      // A full disk shows here, as the buffer is written out.
      if (file.close() !== 0) throw new Error(`${path}: could not write it`);
    }
    // Exactly the mode asked for, where the umask took some off: a whole
    // process here, as QuickJS's os has no chmod.
    if (fileMode(temporary) !== mode) os.exec(["chmod", mode.toString(8), temporary], { block: true });
    if (os.rename(temporary, path) !== 0) throw new Error(`${path}: could not replace it`);
  } catch (e) {
    os.remove(temporary);
    throw e;
  }
};

export const removeFile = (path: string) => {
  os.remove(path);
};

export const listDir = (path: string) => {
  const [names, error] = os.readdir(path);
  return error ? [] : names.filter((name) => name !== "." && name !== "..").sort();
};

export const mkdirp = (path: string, mode?: number) => {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    if (prefix && !fileExists(prefix)) {
      const result = os.mkdir(prefix, mode ?? 0o777);
      if (result < 0 && !fileExists(prefix)) {
        throw fileError(prefix, -result);
      }
    }
  }
  // Exactly the mode asked for (the umask may have taken some off, or it
  // existed already): checked first, as a chmod is a whole process here.
  if (mode !== undefined && fileMode(path) !== mode) os.exec(["chmod", mode.toString(8), path], { block: true });
};

/** Made new, owner-only; false when it exists (mkdir's EEXIST, 17). */
export const makeDir = (path: string) => {
  const result = os.mkdir(path, 0o700);
  if (result === 0) return true;
  if (result === -17) return false;
  throw fileError(path, -result);
};

export const privateDir = (path: string) => {
  mkdirp(dirname(path));
  const made = os.mkdir(path, 0o700);
  if (made < 0 && made !== -17) throw fileError(path, -made);
  const [stat] = os.lstat(path);
  if (!stat || (stat.mode & os.S_IFMT) !== os.S_IFDIR || stat.uid !== ownUid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${path} is not this program's own (a directory of its user's, mode 700, not a link): refused`);
  }
};

export const removeDir = (path: string) => {
  if (fileExists(path)) spawnSync(["rm", "-rf", path]);
};

export const modifiedAt = (path: string) => os.stat(path)[0]?.mtime;

export const fileMode = (path: string) => {
  const [stat] = os.stat(path);
  return stat ? stat.mode & 0o777 : undefined;
};

export const fileSize = (path: string) => os.stat(path)[0]?.size ?? 0;

export const readFileHead = (path: string, bytes: number) => {
  const file = std.open(path, "rb");
  if (!file) throw new Error(`${path}: cannot open`);
  try {
    const buffer = new ArrayBuffer(bytes);
    return new Uint8Array(buffer, 0, file.read(buffer, 0, bytes));
  } finally {
    file.close();
  }
};

export { fileExists };

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

export const sha256 = (text: string) =>
  sha256Of(spawnSync([...requireSha256(), "-"], text));

export const sha256File = async (path: string) =>
  sha256Of(await spawn([...requireSha256(), path]));
