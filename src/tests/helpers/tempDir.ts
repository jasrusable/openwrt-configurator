import test from "ava";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const made: string[] = [];

// Registered as this helper is imported, so with the importing file's tests.
test.after.always(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A fresh directory (`onc-<name>-…` in the system's temp), removed after the file's tests. */
export const tempDir = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `onc-${name}-`));
  made.push(dir);
  return dir;
};
