// The QuickJS platform: OpenWrt devices, and macOS via Homebrew's quickjs.
// Processes, files, HTTP and SSH each live in their own module here.
import * as std from "std";
import { Platform } from "../../platform";
import {
  fileMode,
  mkdirp,
  readFileHead,
  readTextFile,
  removeFile,
  listDir,
  makeDir,
  removeDir,
  modifiedAt,
  sha256,
  sha256File,
  writeFileAtomic,
  writeTextFile,
  appendTextFile,
} from "./files";
import { http } from "./http";
import { removeTmpDir, resolveArgv, spawn, spawnDetached } from "./process";
import { fileExists, os, sleep } from "./runtime";
import { connect } from "./ssh";

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
  appendTextFile,
  mkdirp,
  fileMode,
  removeFile,
  listDir,
  makeDir,
  removeDir,
  modifiedAt,
  readFileHead,
  sha256,
  sha256File,

  http,

  run: async (argv, options) => {
    const { timedOut, ...result } = await spawn(argv, {
      stdin: options?.stdin,
    });
    return result;
  },
  runInteractive: async (argv) =>
    os.exec(resolveArgv(argv), { block: true, usePath: false }),
  spawnDetached,
  commandLineOf: async (pid) => {
    // /proc reports a size of 0, so it is read as a stream (readTextFile), never std.loadFile.
    if (fileExists("/proc/self")) {
      try {
        // An exited child not yet reaped has an empty one: not running.
        return readTextFile(`/proc/${pid}/cmdline`).replace(/\0/g, " ").trim() || undefined;
      } catch {
        return undefined;
      }
    }
    const out = await spawn(["ps", "-ww", "-p", String(pid), "-o", "command="]);
    return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : undefined;
  },
  onStop: (handler) => {
    const signals: [string, number][] = [["SIGHUP", 1], ["SIGINT", os.SIGINT], ["SIGTERM", os.SIGTERM]];
    for (const [name, number] of signals) {
      os.signal(number, () => {
        handler(name);
        removeTmpDir();
        std.out.flush();
        std.err.flush();
        std.exit(128 + number);
      });
    }
  },

  connect,

  writeFileAtomic,
  readStdin: () => std.fdopen(0, "r")?.readAsString() ?? "",
  // How both packages run the bundle (see packaging/).
  selfCommand: () => ["qjs", "--module", scriptArgs[0]],
};
