import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { applyDiff } from "../../applyDiff";
import { DeviceFacts } from "../../deviceFacts";
import { deviceSchemaSchema } from "../../deviceSchema";
import { compileIntent } from "../../intent/compile";
import { Intent, intentSchema } from "../../intent/schema";
import { oncConfigSchema } from "../../oncConfigSchema";

const root = join(__dirname, "..", "..", "..");
const sample = (): Intent =>
  intentSchema.parse(JSON.parse(readFileSync(join(root, "sampleConfigs", "intent.json"), "utf8")));
const compile = (intent: Intent) => oncConfigSchema.parse(compileIntent(intent));
const facts = (hostname: string, model: string): DeviceFacts => ({
  hostname,
  readAt: 0,
  schema: deviceSchemaSchema.parse(
    JSON.parse(readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8"))
  ),
});
const known = {
  "home-router": facts("home-router", "friendlyarm,nanopi-r6s"),
  "home-ap-1": facts("home-ap-1", "zyxel,nwa50ax-pro"),
};
const diff = (change: (intent: Intent) => void, withFacts: Record<string, DeviceFacts | undefined> = known) => {
  const after = sample();
  change(after);
  return applyDiff({ before: compile(sample()), after: compile(after), facts: withFacts });
};
const device = (diffs: ReturnType<typeof applyDiff>, hostname: string) => {
  const d = diffs.find((x) => x.hostname === hostname)!;
  if ("unknown" in d) throw new Error(`${hostname} unknown`);
  return d;
};

test("nothing changed: no lines, packages or files", (t) => {
  for (const d of diff(() => {})) {
    t.false("unknown" in d);
    if (!("unknown" in d)) t.deepEqual([d.config, d.packages, d.files], [[], { added: [], removed: [] }, []]);
  }
});

test("a setting's change shows as the UCI lines it changes, on the devices it touches", (t) => {
  const d = diff((i) => (i.networks[1].subnet = "10.0.21.0/24"));
  t.deepEqual(
    device(d, "home-router").config.find((c) => c.key === "network.guest.ipaddr"),
    { key: "network.guest.ipaddr", before: "'10.0.20.1'", after: "'10.0.21.1'" }
  );
  t.true(device(d, "home-ap-1").config.every((c) => !c.key.startsWith("dhcp.")), "an access point serves no DHCP");
});

test("a Wi-Fi password change shows, but never the password", (t) => {
  const d = device(diff((i) => (i.wifi[0].password = "a-new-secret-1")), "home-ap-1");
  const keys = d.config.filter((c) => c.key.endsWith(".key"));
  t.true(keys.length > 0);
  t.true(keys.every((c) => c.before === "(hidden)" && c.after === "(hidden)"));
  t.false(JSON.stringify(d).includes("a-new-secret-1"));
});

test("nothing applied yet: everything is new; never read: unknown", (t) => {
  const after = compile(sample());
  const first = applyDiff({ after, facts: { "home-router": known["home-router"] } });
  const router = device(first, "home-router");
  t.true(router.config.length > 50 && router.config.every((c) => c.before === undefined));
  t.true(router.packages.added.length > 0);
  t.deepEqual(first.find((d) => d.hostname === "home-ap-1"), { hostname: "home-ap-1", unknown: true });
});
