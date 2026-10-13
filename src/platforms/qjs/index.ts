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
  sha256,
  sha256File,
  writeFileAtomic,
  writeTextFile,
  appendTextFile,
} from "./files";
import { http } from "./http";
import { removeTmpDir, resolveArgv, spawn } from "./process";
import { os, sleep } from "./runtime";
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

  connect,

  writeFileAtomic,
  readStdin: () => std.fdopen(0, "r")?.readAsString() ?? "",
  // How both packages run the bundle (see packaging/).
  selfCommand: () => ["qjs", "--module", scriptArgs[0]],
};
