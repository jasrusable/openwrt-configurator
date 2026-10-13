// What this app keeps (src/store.ts): whole values, owner-only, and writers
// in several processes at once (a CGI request, the collector, a job) never
// trip over each other.
import test from "ava";
import { spawn } from "child_process";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { nodePlatform } from "../../platforms/node";
import { read, StoreKey } from "../../store";
import { repoRoot } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const key = (path: string): StoreKey<{ writer: number; n: number; pad: string }> => ({
  path,
  schema: z.object({ writer: z.number(), n: z.number(), pad: z.string() }),
  format: 1,
});

const writer = (path: string, id: number) =>
  new Promise<number | null>((resolve) => {
    const script = `
      const { nodePlatform } = require("./src/platforms/node");
      const { write } = require("./src/store");
      const { z } = require("zod");
      const key = { path: ${JSON.stringify(path)}, schema: z.any(), format: 1 };
      for (let n = 0; n < 150; n++) write(nodePlatform, key, { writer: ${id}, n, pad: "x".repeat(20000) });
    `;
    const child = spawn(process.execPath, ["-r", "ts-node/register/transpile-only", "-e", script], { cwd: repoRoot, stdio: "inherit" });
    child.on("close", resolve);
  });

test("writers in several processes at once: each write whole, none fails, nothing left behind", async (t) => {
  const dir = tempDir("store");
  const path = join(dir, "value.json");
  const codes = await Promise.all([1, 2, 3, 4].map((id) => writer(path, id)));
  t.deepEqual(codes, [0, 0, 0, 0], "no writer threw");
  const value = read(nodePlatform, key(path));
  t.truthy(value, "the value kept is one whole write");
  t.is(value?.n, 149, "some writer's last");
  t.deepEqual(readdirSync(dir), ["value.json"], "no temporary file left");
  t.is(statSync(path).mode & 0o777, 0o600);
});
