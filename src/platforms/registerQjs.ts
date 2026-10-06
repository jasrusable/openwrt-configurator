// Imported first by the QuickJS entry point, for its side effects.
import * as std from "std";
import { setPlatform } from "../platform";
import { qjsPlatform } from "./qjs";

// QuickJS only provides console.log. Send warnings and errors to stderr like
// Node does, so `2>/dev/null` and pipelines behave the same on both.
const format = (parts: unknown[]) =>
  parts
    .map((part) =>
      typeof part === "string"
        ? part
        : part instanceof Error
        ? part.stack || String(part)
        : JSON.stringify(part)
    )
    .join(" ");
const toStderr = (...parts: unknown[]) => {
  std.err.puts(format(parts) + "\n");
  std.err.flush();
};
const console_ = globalThis.console as unknown as Record<string, unknown>;
console_.warn = toStderr;
console_.error = toStderr;
console_.info = console_.log;

setPlatform(qjsPlatform);
