import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { readFileSync } from "fs";
import { join } from "path";
import { DeviceRead, deviceDiff } from "../../applyDiff";
import { DeviceNow, stateHash, uciLines } from "../../deviceState";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtState } from "../../engine/getOpenWrtState";
import { compileIntent } from "../../intent/compile";
import { Intent } from "../../intent/schema";
import { OpenWrtState } from "../../engine/openWrtState";
import { nodePlatform } from "../../platforms/node";
import { provisionableDevices } from "../../apply/provisionConfig";
import { declaredConfigs } from "../../engine/uci";
import { AppliedStamp, originsOf, stampOf } from "../../applyChanges";
import { durationWords, effectsOf, impactFacts, secondsOf, worst } from "../../applyImpact";
import { buildApplyPlan } from "../../applyPlan";
import { planText } from "../../applyPlanText";
import { ok, err } from "../../result";
import { problem } from "../../problem";

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
type Read = Extract<ReturnType<typeof deviceDiff>, { config: unknown }>;
/** The lines, packages and files that change, without why or what they are called (tested below). */
const diff = (state: OpenWrtState, now: DeviceNow) => {
  const d = deviceDiff({ hostname: "x", state, now, sha256: nodePlatform.sha256 }) as Read;
  return {
    config: d.config.map(({ key, before, after, renamedFrom }): { key: string; before?: string; after?: string; renamedFrom?: string } =>
      renamedFrom ? { key, renamedFrom } : { key, before, after }
    ),
    packages: { added: d.packages.added, removed: d.packages.removed },
    files: d.files.map(({ path, change }) => ({ path, change })),
  };
};

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

const classified = ({
  hostname = "home-router",
  intent,
  now,
  last,
  stamp,
}: {
  hostname?: string;
  intent: Intent;
  now: DeviceNow;
  last?: OpenWrtState;
  stamp?: AppliedStamp;
}) => {
  const plan = compileIntent(intent);
  const deviceConfig = provisionableDevices(plan).ready.find((d) => d.hostname === hostname)!;
  const deviceSchema = deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", `${models[hostname]}.json`), "utf8")));
  return deviceDiff({
    hostname,
    state: getOpenWrtState({ plan, deviceConfig, deviceSchema }),
    now,
    sha256: nodePlatform.sha256,
    ...(last ? { last: { state: last } } : {}),
    ...(stamp ? { stamp } : {}),
    origins: originsOf(plan, deviceConfig, deviceSchema),
    intent,
  }) as Read;
};
const stampFor = (state: OpenWrtState) => stampOf(uciLines(declaredConfigs(state.config)), state, nodePlatform.sha256);
const whys = (d: Read) => Object.fromEntries(d.config.map((c) => [c.key, c.why]));

test("each change says why: an edit, an app update, or a change on the device", (t) => {
  const today = stateFor(sample(), "home-router");
  // What an older version of the app wrote for the same settings: one option more.
  const older: OpenWrtState = {
    ...today,
    config: {
      ...today.config,
      dropbear: { dropbear: today.config.dropbear.dropbear.map((s) => ({ ...s, Interface: "lan" })) },
    },
  };
  const now = appliedWith(older);
  // And by hand since: wan's forward policy.
  const drifted: DeviceNow = {
    ...now,
    config: {
      ...now.config,
      firewall: now.config.firewall.map((s) => (s.name === "wan" ? { ...s, options: { ...s.options, forward: "ACCEPT" } } : s)),
    },
  };
  const edited = sample();
  edited.networks[1].subnet = "10.0.21.0/24";
  const d = classified({ intent: edited, now: drifted, last: today, stamp: stampFor(older) });
  t.like(whys(d), { "network.guest.ipaddr": "edit", "dropbear.main.Interface": "update", "firewall.wan.forward": "device" });
  // Without a stamp the last two cannot be told apart; with nothing applied yet everything is new.
  t.like(whys(classified({ intent: edited, now: drifted, last: today })), {
    "network.guest.ipaddr": "edit",
    "dropbear.main.Interface": "unknown",
    "firewall.wan.forward": "unknown",
  });
  t.true(classified({ intent: edited, now: drifted }).config.every((c) => c.why === "first"));
});

test("a stamp holds hashes only, and never a secret's", (t) => {
  const state = stateFor(sample(), "home-ap-1");
  const stamp = stampFor(state);
  t.false(Object.keys(stamp.lines).some((key) => key.endsWith(".key")));
  t.true(Object.values(stamp.lines).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  t.false(JSON.stringify(stamp).includes(sample().wifi.networks[0].password));
});

test("a change is named for the setting it comes from", (t) => {
  const edited = sample();
  edited.wifi.networks[0].ssid = "Renamed";
  const d = classified({ hostname: "home-ap-1", intent: edited, now: appliedWith(stateFor(sample(), "home-ap-1")), last: stateFor(sample(), "home-ap-1") });
  const ssid = d.config.filter((c) => c.key.endsWith(".ssid"));
  t.true(ssid.length > 0);
  t.true(ssid.every((c) => c.setting === "wifi.networks.0.ssid" && c.why === "edit" && !c.label.includes("wireless.")), JSON.stringify(ssid));
});

test("what applying is noticed as, and how long it takes", (t) => {
  const facts = impactFacts(stateFor(sample(), "home-ap-1"), "ap");
  const [radio, network] = [Object.keys(facts.radios)[0], Object.keys(facts.networks)[0]];
  const nothing = { added: [], removed: [] };
  const quiet = { hostname: "ap", keys: ["firewall.wan.forward"], packages: nothing, files: [], facts };
  t.deepEqual(effectsOf(quiet), []);
  // 25.12's hostapd.uc: a radio option restarts the radio; a network's, only that network.
  const ssid = effectsOf({ ...quiet, keys: [`wireless.${network}.ssid`] });
  t.deepEqual(ssid.map((e) => e.disruption), ["reconnect"]);
  t.regex(ssid[0].text, /networks that change on ap restart.*other networks stay up/);
  const channel = effectsOf({ ...quiet, keys: [`wireless.${radio}.channel`, `wireless.${network}.ssid`] });
  t.is(channel.length, 1, "the network goes with its radio");
  t.regex(channel[0].text, /^Wi-Fi restarts on ap's [\d.]+ GHz radio: every device on it reconnects/);
  const loud = { ...quiet, keys: ["dhcp.lan.start"], packages: { added: ["a", "b"], removed: [] } };
  t.true(effectsOf(loud).some((e) => e.text.startsWith("DNS and DHCP restart")));
  t.true(effectsOf(loud).some((e) => e.text.startsWith("Installs 2 packages")));
  t.is(worst(effectsOf(loud)), "brief");
  const wifi = { ...quiet, keys: [`wireless.${radio}.channel`] };
  t.true(secondsOf(wifi) > secondsOf(quiet));
  t.is(durationWords([secondsOf(quiet)]), "about a minute");
  t.is(durationWords([secondsOf(loud), secondsOf(loud)]), "about 3 minutes");
});

test("a state hash changes with the device, and never depends on a secret", (t) => {
  const now = appliedWith(stateFor(sample(), "home-ap-1"));
  const hash = (n: DeviceNow) => stateHash(n, nodePlatform.sha256);
  const withOption = (option: string, value: string): DeviceNow => ({
    ...now,
    config: { ...now.config, wireless: now.config.wireless.map((s) => (s.type === "wifi-iface" ? { ...s, options: { ...s.options, [option]: value } } : s)) },
  });
  t.is(hash(now), hash({ ...now, installed: [...now.installed].reverse() }));
  t.not(hash(now), hash(withOption("ssid", "Other")));
  t.not(hash(now), hash({ ...now, installed: [...now.installed, "tcpdump"] }));
  t.is(hash(now), hash(withOption("key", "another-secret")), "a key's value is not in it");
  // An owner-only managed file (root's password): there or not counts, never its content.
  const password = { ...now, managed: [...now.managed, "/etc/onc/root-password"], secret: ["/etc/onc/root-password"] };
  const holding = (sha: string) => hash({ ...password, hashes: { ...password.hashes, "/etc/onc/root-password": sha } });
  t.is(holding("1".repeat(64)), holding("2".repeat(64)));
  const { "/etc/onc/root-password": _gone, ...without } = password.hashes;
  t.not(holding("1".repeat(64)), hash({ ...password, hashes: without }), "whether it is there still counts");
});

/** A device read for the plan: the sample applied, then `edit` made, the device changed by `drift`. */
const readOf = ({
  hostname = "home-ap-1",
  edit = (i: Intent) => i,
  drift = (n: DeviceNow) => n,
  space,
}: {
  hostname?: string;
  edit?: (intent: Intent) => Intent;
  drift?: (now: DeviceNow) => DeviceNow;
  space?: { needKb: number; freeKb: number };
}): DeviceRead => {
  const applied = stateFor(sample(), hostname);
  const now = drift(appliedWith(applied));
  return {
    ...classified({ hostname, intent: edit(sample()), now, last: applied, stamp: stampFor(applied) }),
    hash: stateHash(now, nodePlatform.sha256),
    ...(space ? { space } : {}),
  };
};

test("the plan: items by source, the most noticed first, with what to acknowledge", (t) => {
  const edit = (i: Intent) => {
    i.wifi.networks[0].ssid = "Renamed";
    return i;
  };
  const drift = (n: DeviceNow): DeviceNow => ({
    ...n,
    config: { ...n.config, system: n.config.system.map((s) => ({ ...s, options: { ...s.options, zonename: "Somewhere" } })) },
  });
  const ap = readOf({ edit, drift, space: { needKb: 2048, freeKb: 1024 } });
  const plan = buildApplyPlan({
    reads: [ok(ap), err(problem("unreachable", "No answer", { hostname: "home-router" }))],
    edits: [{ path: "wifi.networks.0.ssid", label: ["Wi-Fi", "“Home”", "Name"], kind: "changed", before: "Home", after: "Renamed" }],
    readAt: 1,
  });
  const [first] = plan.items;
  t.is(first.source, "edit");
  t.is(first.effect.disruption, "reconnect");
  t.is(first.change, "Home → Renamed");
  // Its section is named for the SSID, so it is renamed too: renames after the configs.
  t.deepEqual(first.lines[0].groups.map((g) => g.title), ["wireless", "renamed"]);
  const drifted = plan.items.find((i) => i.source === "drift")!;
  t.is(drifted.title, "Changed on home-ap-1");
  t.deepEqual(plan.needs.map((n) => n.kind), ["disruption", "drift", "flash"]);
  const [dropping] = plan.needs;
  t.true(dropping.kind === "disruption" && dropping.effects.every((e) => /reconnect/.test(e)), "only what drops devices needs a tick");
  t.regex(plan.summary.blocked ?? "", /too little flash/);
  t.deepEqual(plan.unread, [{ device: "home-router", error: "No answer" }]);
  t.deepEqual(plan.verify, { "home-ap-1": ap.hash });
  // Unread, and no flash short: refused as the run would (a device not reviewed is never applied).
  const roomy = buildApplyPlan({ reads: [ok(readOf({ edit, drift })), err(problem("unreachable", "No answer", { hostname: "home-router" }))], edits: [], readAt: 1 });
  t.regex(roomy.summary.blocked ?? "", /home-router could not be read.*it would be refused/);
  t.regex(plan.summary.verdict, /^\d+ changes on home-ap-1\. Devices may drop off .* Replaces \d+ changes? made on the devices .* home-router could not be read/);
  // The CLI says the same plan.
  const text = planText(plan);
  t.true(text.startsWith(plan.summary.verdict));
  t.true(text.includes("[Your edit] Wi-Fi › “Home” › Name: Home → Renamed"));
  t.false(text.includes(sample().wifi.networks[0].password), "no secret in words");
});

test("the plan: nothing to change is up to date", (t) => {
  const plan = buildApplyPlan({ reads: [ok(readOf({}))], edits: [], readAt: 1 });
  t.deepEqual(plan.items, []);
  t.deepEqual(plan.needs, []);
  t.is(plan.summary.verdict, "Everything is up to date: applying would change nothing.");
});
