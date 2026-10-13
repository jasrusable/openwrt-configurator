// From a terminal, `provision` of an intent finds its devices as the web UI
// does (src/locate.ts): an access point known only by name, never pinned, is
// refused before anything connects to that name, and nothing is applied.
import test from "ava";
import { join } from "path";
import { writeFileSync } from "fs";
import { main } from "../../cli";
import { nodePlatform } from "../../platforms/node";
import { sampleIntentJson } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

test("provision of an intent refuses an access point never pinned, before connecting to its name", async (t) => {
  const dir = tempDir("cli-trust");
  const intent = sampleIntentJson();
  // An address no network here uses, though nothing is reached anyway.
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, JSON.stringify(intent).replace(/10\.0\.0\./g, "10.254.0."), { mode: 0o600 });
  const tried: string[] = [];
  const platform = {
    ...nodePlatform,
    env: (name: string) => (name === "ONC_KNOWN_HOSTS" ? join(dir, "known_hosts") : nodePlatform.env(name)),
    connect: async (target: { host?: string }) => {
      tried.push(target.host ?? "");
      throw new Error("unreachable in this test");
    },
  };
  const error = await t.throwsAsync(() => main({ argv: ["provision", intentPath], platform }));
  t.regex(error!.message, /Not applied: [\s\S]*could not be found safely[\s\S]*not tried, no host key on record/);
  t.false(tried.some((host) => /\.lan$/.test(host)), "the name was never connected to");
});
