// The fixes as people see them (src/intent/patches): where each applies,
// device by device, from the intent and the devices' facts; which fixes can
// go; and which of an apply's changes each fix makes, derived from its effect.
import test from "ava";
import { readFileSync, writeFileSync } from "fs";
import { uiHandler } from "../../server/app";
import { nodePlatform } from "../../platforms/node";
import { tempDir } from "../helpers/tempDir";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { compileIntent } from "../../intent/compile";
import { droppableFixes, patchStatus, shownPatches } from "../../intent/patches/status";
import { deviceDiff, fixSources } from "../../applyDiff";
import { getOpenWrtState } from "../../engine/getOpenWrtState";
import { sampleIntent } from "../helpers/fixtures";

const root = join(__dirname, "..", "..", "..");
const schema = (model: string, version?: string) => {
  const s = deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8")));
  return version ? { ...s, version } : s;
};

/** The sample with fast roaming on its first SSID: the 802.11r fix is needed. */
const intent = () => {
  const i = sampleIntent();
  i.wifi.networks = i.wifi.networks.map((ssid, n) => ({ ...ssid, roaming: { ...ssid.roaming, fast: n === 0 }, ...(n === 0 ? { security: "wpa2-wpa3" as const, extra_passwords: undefined } : {}) }));
  return i;
};
const facts = (apVersion: string) => ({
  "home-router": { schema: schema("friendlyarm,nanopi-r6s") },
  "home-ap-1": { schema: schema("zyxel,nwa50ax-pro", apVersion) },
});
const stateOf = (views: ReturnType<typeof patchStatus>, id: string) =>
  Object.fromEntries(views.find((v) => v.id === id)!.devices.map((d) => [d.device, [d.state, d.why]]));

test("each fix, device by device: active, not for this device and why, turned off, unknown before facts", (t) => {
  const views = patchStatus(intent(), facts("25.12.5"));
  t.deepEqual(stateOf(views, "ft-key-race"), {
    "home-router": ["elsewhere", "only where it has Wi-Fi"],
    "home-ap-1": ["active", undefined],
  });
  t.deepEqual(stateOf(views, "r6s-packet-steering"), {
    "home-router": ["active", undefined],
    "home-ap-1": ["elsewhere", "only on friendlyarm,nanopi-r6s"],
  });
  t.deepEqual(stateOf(views, "usteer-nudge-requests")["home-ap-1"], ["unused", "not needed by your settings"]);
  const off = intent();
  off.system.patches = { off: ["ft-key-race"] };
  t.deepEqual(stateOf(patchStatus(off, facts("25.12.5")), "ft-key-race")["home-ap-1"], ["off", "turned off"]);
  t.deepEqual(stateOf(patchStatus(intent(), {}), "ft-key-race")["home-ap-1"], ["unknown", "not read yet"]);
  const ft = views.find((v) => v.id === "ft-key-race")!;
  t.like(ft, { title: "Fast roaming held off with WPA3 on OpenWrt 25.12", required: false, kind: "fix", where: "where it has Wi-Fi, from OpenWrt 25.12.0" });
  t.true(ft.effects.length > 0 && ft.references.length > 0);
});

test("the pages list a patch only when it overrides a setting, and still when it is turned off", (t) => {
  const i = intent();
  t.deepEqual(shownPatches(i), ["ft-key-race"]);
  i.system.patches = { off: ["ft-key-race"] };
  t.deepEqual(shownPatches(i), ["ft-key-race"], "turned off, it still has a row to turn back on");
  i.wifi.roaming.steering = "nudge";
  t.deepEqual(shownPatches(i), ["ft-key-race", "usteer-nudge-requests"]);
});

test("a fix every device has moved past is one to drop; one still active or not yet known is not", (t) => {
  // usteer's Nudge fix holds before 26.0: an access point on 26.0 has the fixed usteer.
  const nudge = intent();
  nudge.wifi.roaming.steering = "nudge";
  t.deepEqual(stateOf(patchStatus(nudge, facts("26.0")), "usteer-nudge-requests")["home-ap-1"], ["fixed", "fixed in OpenWrt 26.0; it runs 26.0"]);
  t.deepEqual(droppableFixes(nudge, facts("26.0")).map((f) => f.id), ["usteer-nudge-requests"]);
  t.deepEqual(droppableFixes(nudge, facts("25.12.5")), [], "still active on 25.12");
  t.deepEqual(droppableFixes(nudge, {}), [], "nothing known, nothing to drop");
});

test("the apply diff says which changes come from a fix, worked out from what the fix changes", (t) => {
  const i = intent();
  const plan = compileIntent(i);
  const deviceConfig = plan.devices.find((d) => d.hostname === "home-ap-1")!;
  const deviceSchema = schema("zyxel,nwa50ax-pro", "25.12.5");
  const state = getOpenWrtState({ plan, deviceConfig, deviceSchema });
  const fixes = fixSources({ intent: i, deviceConfig, deviceSchema, state });
  const diff = deviceDiff({
    hostname: "home-ap-1",
    state,
    now: { config: {}, installed: [], managed: [], hashes: {} },
    sha256: (text) => String(text.length),
    fixes,
  });
  const fastRoaming = diff.config.filter((c) => c.key.endsWith(".ieee80211r"));
  t.true(fastRoaming.some((c) => c.after === "'0'" && c.fix === "Fast roaming held off with WPA3 on OpenWrt 25.12"), "the held-off line says which fix");
  t.true(diff.config.some((c) => c.key.endsWith(".bss_load_update_period") && c.fix === "Channel load not advertised on the NWA50AX Pro"));
  t.true(diff.files.some((f) => f.fix === "Energy Efficient Ethernet off on the NWA50AX Pro's port"));
  t.is(diff.packages.fixes?.["ethtool-full"], "Energy Efficient Ethernet off on the NWA50AX Pro's port");
  t.true(diff.config.filter((c) => c.key.endsWith(".ssid")).every((c) => !c.fix), "what the settings make has no fix");
});

test("GET /api/patches: every fix with where it applies, from the saved settings and stored facts, no device read", async (t) => {
  const dir = tempDir("fixes-api");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, JSON.stringify(intent()), { mode: 0o600 });
  const handle = uiHandler({ intentPath, uiRoot: dir, platform: nodePlatform });
  const response = await handle({ method: "GET", path: "/api/patches", body: "", headers: { "x-onc": "1" } });
  t.is(response.status, 200);
  const { patches: views } = JSON.parse(response.body) as { patches: ReturnType<typeof patchStatus> };
  const ft = views.find((v) => v.id === "ft-key-race")!;
  t.deepEqual(ft.devices.map((d) => [d.device, d.state]), [["home-router", "unknown"], ["home-ap-1", "unknown"]], "no facts stored: not known yet");
  t.true(views.every((v) => v.title && v.references.length && v.effects.length));
});
