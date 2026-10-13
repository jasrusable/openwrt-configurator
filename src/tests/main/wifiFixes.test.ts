// The Wi-Fi fixes from the 2026-10-13 research: each patch where it targets
// and nowhere else, the radar setting, the survey's implausible counters, and
// the mesh nodes' releases (src/intent/patches, wifi, status).
import test from "ava";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtState } from "../../engine/getOpenWrtState";
import { availability } from "../../intent/choices";
import { compileIntent } from "../../intent/compile";
import { explainFor } from "../../intent/fields";
import type { Intent } from "../../intent/schema";
import { parseSurvey } from "../../status/actions";
import { attentionOf } from "../../status/views";
import { readRepoJson, sampleIntent } from "../helpers/fixtures";

const board = (model: string, version: string) => ({
  ...deviceSchemaSchema.parse(readRepoJson("deviceSchemas", `${model}.json`)),
  version,
});

const stateOn = (intent: Intent, hostname: string, model: string, version = "25.12.5") => {
  const plan = compileIntent(intent);
  return getOpenWrtState({ plan, deviceConfig: plan.devices.find((d) => d.hostname === hostname)!, deviceSchema: board(model, version) });
};

type Options = Record<string, unknown>;
const sections = (state: ReturnType<typeof stateOn>, config: string, type: string) =>
  ((state.config as Record<string, Record<string, Options[]>>)[config]?.[type] ?? []) as Options[];
const option = (section: Options, name: string) => (section.options as Options | undefined)?.[name] ?? section[name];

test("fast roaming is held off on 25.12 with WPA3 (the FT key race), kept with WPA2, the setting kept and its explainer saying so", (t) => {
  const intent = sampleIntent();
  t.true(intent.wifi.networks.every((s) => s.roaming.fast && s.security === "wpa2"), "the sample: fast roaming on, WPA2");
  const wpa2 = sections(stateOn(intent, "home-ap-1", "zyxel,nwa50ax-pro"), "wireless", "wifi-iface");
  t.true(wpa2.length > 0 && wpa2.every((s) => [true, 1, "1"].includes(option(s, "ieee80211r") as never)), "WPA2: kept");
  Object.assign(intent.wifi.networks[0], { security: "wpa2-wpa3", extra_passwords: undefined });
  const ifaces = sections(stateOn(intent, "home-ap-1", "zyxel,nwa50ax-pro"), "wireless", "wifi-iface");
  const ssid = intent.wifi.networks[0].ssid;
  t.true(ifaces.filter((s) => option(s, "ssid") === ssid).every((s) => [false, 0, "0"].includes(option(s, "ieee80211r") as never)), "WPA2/WPA3: held off");
  t.regex(explainFor(["wifi", "networks", "0", "roaming", "fast"], intent) ?? "", /Held off with WPA3 on OpenWrt 25\.12.*https:\/\/github\.com\/openwrt\/openwrt\/pull\/23181/);
  t.notRegex(explainFor(["wifi", "networks", "1", "roaming", "fast"], intent) ?? "", /Held off/);
});

test("BSS Load is off only where mt76#1135 was seen; elsewhere OpenWrt's default", (t) => {
  const intent = sampleIntent();
  const zyxel = sections(stateOn(intent, "home-ap-1", "zyxel,nwa50ax-pro"), "wireless", "wifi-iface");
  t.true(zyxel.every((s) => String(option(s, "bss_load_update_period")) === "0" && String(option(s, "chan_util_avg_period")) === "0"));
  const other = sections(stateOn(intent, "home-ap-1", "tplink,archer-c50-v4"), "wireless", "wifi-iface");
  t.true(other.length > 0 && other.every((s) => option(s, "bss_load_update_period") === undefined));
  t.true(other.every((s) => option(s, "max_inactivity") === undefined), "OpenWrt's own inactivity check (it polls before dropping)");
});

test("Nudge on 25.12's usteer asks devices what they see but never triggers a move-then-disconnect", (t) => {
  const intent = sampleIntent();
  intent.wifi.roaming.steering = "nudge";
  const [usteer] = sections(stateOn(intent, "home-ap-1", "zyxel,nwa50ax-pro"), "usteer", "usteer");
  t.is(String(option(usteer, "roam_trigger_snr")), "0");
  t.regex(explainFor(["wifi", "roaming", "steering"], intent) ?? "", /On OpenWrt 25\.12.*Nudge only shares neighbour lists/);
  intent.wifi.roaming.steering = "push";
  const [pushed] = sections(stateOn(intent, "home-ap-1", "zyxel,nwa50ax-pro"), "usteer", "usteer");
  t.not(String(option(pushed, "roam_trigger_snr")), "0", "Push keeps its trigger");
});

test("the NWA50AX Pro's Ethernet power saving is off, with ethtool installed; no other model", (t) => {
  const intent = sampleIntent();
  const zyxel = stateOn(intent, "home-ap-1", "zyxel,nwa50ax-pro");
  t.true(zyxel.packages.add.includes("ethtool-full"));
  t.true(zyxel.files.some((f) => f.path === "/etc/hotplug.d/net/30-onc-eee-off" && /set-eee eth0 eee off/.test(f.content)));
  const other = stateOn(intent, "home-ap-1", "tplink,archer-c50-v4");
  t.false(other.files.some((f) => f.path.includes("eee-off")));
});

test("Avoid radar channels: 5 GHz only, an automatic channel excluded from DFS", (t) => {
  const intent = sampleIntent();
  intent.wifi.radios["5g"].avoid_radar = true;
  const devices = sections(stateOn(intent, "home-ap-1", "zyxel,nwa50ax-pro"), "wireless", "wifi-device");
  const fives = devices.filter((d) => option(d, "band") === "5g");
  t.true(fives.length > 0 && fives.every((d) => [true, 1, "1"].includes(option(d, "acs_exclude_dfs") as never)));
  t.true(devices.filter((d) => option(d, "band") === "2g").every((d) => option(d, "acs_exclude_dfs") === undefined));
  t.truthy(availability(intent, "wifi.radios.2g.avoid_radar").option(true).unavailable, "2.4 GHz has no radar channels");
  t.falsy(availability(intent, "wifi.radios.5g.avoid_radar").option(true).unavailable);
});

test("a survey's counters that cannot be right (busy over active, or wrapped) read as unknown, not 100% busy", (t) => {
  const survey = parseSurvey("ap", [
    {
      ifname: "phy1-ap0",
      bssid: "02:00:00:00:00:01",
      survey: {
        results: [
          { mhz: 5180, active_time: 1000, busy_time: 250, in_use: true },
          { mhz: 5200, active_time: 1000, busy_time: 5000 },
          { mhz: 5220, active_time: 18446744073709550, busy_time: 300 },
        ],
      },
      scan: { results: [] },
    },
  ]);
  t.deepEqual(
    survey.channels.map((c) => [c.channel, c.busy]),
    [
      [36, 25],
      [40, undefined],
      [44, undefined],
    ]
  );
});

test("the mesh nodes' releases: different ones warned of, and those before batman-adv's fixes", (t) => {
  const intent = sampleIntent();
  intent.wifi.mesh.enabled = true;
  intent.wifi.mesh.band = "5g";
  const facts = Object.fromEntries(
    intent.hardware.map((d, i) => [
      d.name,
      { hostname: d.name, readAt: 0, schema: { ...board("zyxel,nwa50ax-pro", i === 0 ? "25.12.5" : "25.12.4"), radios: [{ name: "radio1", type: "mac80211" as const, band: "5g" as const, mesh: true }] } },
    ])
  );
  const ids = attentionOf({ intent, devices: [], facts }).map((a) => a.id);
  t.true(ids.includes("mesh:releases"));
  t.true(ids.includes("mesh:batman-fixes"));
  const same = Object.fromEntries(Object.entries(facts).map(([k, f]) => [k, { ...f, schema: { ...f.schema, version: "25.12.6" } }]));
  const after = attentionOf({ intent, devices: [], facts: same }).map((a) => a.id);
  t.false(after.includes("mesh:releases"));
  t.false(after.includes("mesh:batman-fixes"));
});
