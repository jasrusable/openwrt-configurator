import * as std from "std";
import { ExecResult } from "../../platform";
import { spawn, spawnSync, which } from "./process";
import { fileExists, os } from "./runtime";

export const readTextFile = (path: string) => {
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

export const writeTextFile = (path: string, data: string) => {
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

export const writeFileAtomic = (path: string, data: string, mode: number) => {
  const temporary = `${path}.onc-tmp`;
  writeTextFile(temporary, data);
  // QuickJS's os has no chmod.
  os.exec(["chmod", mode.toString(8), temporary], { block: true });
  if (os.rename(temporary, path) !== 0) {
    throw new Error(`${path}: could not replace it`);
  }
};

export const removeFile = (path: string) => {
  os.remove(path);
};

export const mkdirp = (path: string) => {
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
};

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
