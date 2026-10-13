import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { readFileSync } from "fs";
import { join } from "path";
import { DeviceNow, deviceDiff } from "../../applyDiff";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtState } from "../../engine/getOpenWrtState";
import { compileIntent } from "../../intent/compile";
import { Intent } from "../../intent/schema";
import { OpenWrtState } from "../../engine/openWrtState";
import { nodePlatform } from "../../platforms/node";
import { provisionableDevices } from "../../apply/provisionConfig";
import { declaredConfigs } from "../../engine/uci";

const root = join(__dirname, "..", "..", "..");
const sample = (): Intent =>
  sampleIntent();
const models: Record<string, string> = { "home-router": "friendlyarm,nanopi-r6s", "home-ap-1": "zyxel,nwa50ax-pro" };

/** What the apply leaves on `hostname` for this intent. */
const stateFor = (intent: Intent, hostname: string) => {
  const plan = compileIntent(intent);
  const deviceConfig = provisionableDevices(plan).ready.find((d) => d.hostname === hostname)!;
  const deviceSchema = deviceSchemaSchema.parse(
    JSON.parse(readFileSync(join(root, "deviceSchemas", `${models[hostname]}.json`), "utf8"))
  );
  return getOpenWrtState({ plan, deviceConfig, deviceSchema });
};
const written = (content: string) => nodePlatform.sha256(content.endsWith("\n") ? content : `${content}\n`);

/** A device that an apply of `state` has just left as it should be. */
const appliedWith = (state: OpenWrtState): DeviceNow => ({
  config: declaredConfigs(state.config),
  installed: state.packages.add,
  managed: state.files.map((f) => f.path),
  hashes: Object.fromEntries(state.files.map((f) => [f.path, written(f.content)])),
});
const diff = (state: OpenWrtState, now: DeviceNow) =>
  deviceDiff({ hostname: "x", state, now, sha256: nodePlatform.sha256 }) as Extract<
    ReturnType<typeof deviceDiff>,
    { config: unknown }
  >;

test("a device already as the settings say: nothing changes", (t) => {
  for (const hostname of Object.keys(models)) {
    const state = stateFor(sample(), hostname);
    const d = diff(state, appliedWith(state));
    t.deepEqual([d.config, d.packages, d.files], [[], { added: [], removed: [] }, []], hostname);
  }
});

test("a setting's change shows as the UCI lines it changes", (t) => {
  const changed = sample();
  changed.networks[1].subnet = "10.0.21.0/24";
  const d = diff(stateFor(changed, "home-router"), appliedWith(stateFor(sample(), "home-router")));
  t.deepEqual(d.config, [
    ...d.config.filter((c) => c.key !== "network.guest.ipaddr"),
    { key: "network.guest.ipaddr", before: "'10.0.20.1'", after: "'10.0.21.1'" },
  ].sort((a, b) => a.key.localeCompare(b.key)));
});

test("a Wi-Fi password change shows, but never the password on either side", (t) => {
  const before = sample();
  before.wifi.networks[0].password = "the-old-secret-1";
  const after = sample();
  after.wifi.networks[0].password = "a-new-secret-1";
  const d = diff(stateFor(after, "home-ap-1"), appliedWith(stateFor(before, "home-ap-1")));
  const keys = d.config.filter((c) => c.key.endsWith(".key"));
  t.true(keys.length > 0);
  t.true(keys.every((c) => c.before === "(hidden)" && c.after === "(hidden)"));
  t.false(JSON.stringify(d).includes("secret-1"));
});

test("what the device has and the settings do not is removed, except what is kept", (t) => {
  const state = stateFor(sample(), "home-router");
  const now = appliedWith(state);
  const keptConfig = state.keep.find((k) => k.type === undefined && !k.optional)!.config;
  const d = diff(state, {
    ...now,
    config: {
      ...now.config,
      network: [...now.config.network, { type: "interface", options: { proto: "dhcp" } }],
      [keptConfig]: [{ type: "anything", name: "mine", options: { x: "1" } }],
    },
  });
  // As uci shows it: an anonymous section's index counts every section of its type.
  const index = now.config.network.filter((s) => s.type === "interface").length;
  t.deepEqual(d.config, [
    { key: `network.@interface[${index}]`, before: "interface", after: undefined },
    { key: `network.@interface[${index}].proto`, before: "'dhcp'", after: undefined },
  ]);
});

test("packages and files: missing, unwanted, changed and no longer managed", (t) => {
  const state = stateFor(sample(), "home-router");
  const now = appliedWith(state);
  const [missing, ...installed] = now.installed;
  const file = state.files[0];
  const d = diff(
    { ...state, packages: { ...state.packages, remove: ["odhcpd-ipv6only"] } },
    {
      ...now,
      installed: [...installed, "odhcpd-ipv6only"],
      managed: [...now.managed, "/etc/old"],
      hashes: { ...now.hashes, [file.path]: "0".repeat(64), "/etc/old": "1".repeat(64) },
    }
  );
  t.deepEqual(d.packages, { added: [missing], removed: ["odhcpd-ipv6only"] });
  t.deepEqual(d.files, [
    { path: "/etc/old", change: "removed" },
    { path: file.path, change: "changed" },
  ].sort((a, b) => a.path.localeCompare(b.path)));
});

test("secrets under any package's option names stay hidden", (t) => {
  const state = stateFor(sample(), "home-ap-1");
  const now = appliedWith(state);
  const d = diff(state, {
    ...now,
    config: {
      ...now.config,
      acme: [{ type: "cert", name: "c", options: { credentials: ["CF_Token=tok-123"] } }],
      wireless: [
        ...now.config.wireless,
        { type: "wifi-iface", name: "x", options: { r0kh: ["ff:ff:ff:ff:ff:ff,*,r0-secret"], key1: "wep-secret" } },
      ],
    },
  });
  t.true(d.config.some((c) => c.key === "wireless.x.r0kh" && c.before === "(hidden)"));
  t.false(/tok-123|r0-secret|wep-secret/.test(JSON.stringify(d)));
});

test("a section that only changed name reads as a rename, with only what differs", (t) => {
  const state = stateFor(sample(), "home-router");
  const now = appliedWith(state);
  const zone = (name: string) => now.config.firewall.find((s) => s.name === name)!;
  const main = now.config.dropbear[0];
  // As another tool left it: the zones the other way round under positional
  // names, wan's forward policy DROP, and dropbear with an extra option.
  const d = diff(state, {
    ...now,
    config: {
      ...now.config,
      firewall: [
        { ...zone("wan"), name: "zone0", options: { ...zone("wan").options, forward: "DROP" } },
        { ...zone("lan"), name: "zone1" },
        ...now.config.firewall.filter((s) => s.type !== "zone"),
      ],
      dropbear: [{ ...main, name: "dropbear0", options: { ...main.options, Interface: "lan" } }],
    },
  });
  t.deepEqual(
    d.config.filter((c) => /^(firewall\.(lan|wan)|dropbear)/.test(c.key)),
    [
      { key: "dropbear.main", renamedFrom: "dropbear.dropbear0" },
      { key: "dropbear.main.Interface", before: "'lan'", after: undefined },
      { key: "firewall.lan", renamedFrom: "firewall.zone1" },
      { key: "firewall.wan", renamedFrom: "firewall.zone0" },
      { key: "firewall.wan.forward", before: "'DROP'", after: "'REJECT'" },
    ]
  );
});

test("sections with little in common are removed and added, not renamed", (t) => {
  const state = stateFor(sample(), "home-router");
  const now = appliedWith(state);
  const d = diff(state, {
    ...now,
    config: { ...now.config, dropbear: [{ type: "dropbear", name: "old", options: { Port: "2222", Interface: "wan" } }] },
  });
  t.false(d.config.some((c) => c.renamedFrom));
  t.true(d.config.some((c) => c.key === "dropbear.old" && c.after === undefined));
});
