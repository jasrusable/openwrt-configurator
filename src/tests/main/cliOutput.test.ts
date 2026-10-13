// The CLI's output reaches a pipe whole: Node's process.exit drops what a
// pipe has not taken yet, which cut `compile | jq` off at 64 KiB.
import test from "ava";
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { repoRoot, sampleIntentJson } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

test("a CLI command's long output arrives whole through a pipe", (t) => {
  const intent = sampleIntentJson();
  // Enough DNS names to compile to well over 200 KB.
  intent.dns = {
    ...intent.dns,
    hosts: Array.from({ length: 4000 }, (_, i) => ({ name: `host-${i}`, address: `10.0.${Math.floor(i / 250)}.${(i % 250) + 2}` })),
  };
  const path = join(tempDir("pipe"), "intent.json");
  writeFileSync(path, JSON.stringify(intent), { mode: 0o600 });
  // spawnSync's stdout is a pipe.
  const piped = spawnSync(process.execPath, ["-r", "ts-node/register/transpile-only", join(repoRoot, "bin/index.ts"), "compile", path], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  t.is(piped.status, 0, piped.stderr);
  t.true(piped.stdout.length > 200 * 1024, `${piped.stdout.length} bytes`);
  t.notThrows(() => JSON.parse(piped.stdout), "and is whole JSON");
});
