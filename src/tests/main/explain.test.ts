import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { compileIntent } from "../../intent/compile";
import { explainFor } from "../../intent/fields";
import { places } from "../../intent/places";
import { steeringLevels } from "../../intent/roaming";
import { Intent } from "../../intent/schema";
import { oncConfigSchema } from "../../oncConfigSchema";

const root = join(__dirname, "..", "..", "..");
const sample = (): Intent =>
  sampleIntent();

/** usteer as the access point gets it. */
const usteerOn = (intent: Intent) => {
  const oncConfig = oncConfigSchema.parse(compileIntent(intent));
  const deviceSchema = deviceSchemaSchema.parse(
    JSON.parse(readFileSync(join(root, "deviceSchemas", "zyxel,nwa50ax-pro.json"), "utf8"))
  );
  const deviceConfig = oncConfig.devices.find((d) => d.hostname === "home-ap-1")!;
  return (getOpenWrtConfig({ oncConfig, deviceConfig, deviceSchema }) as any).usteer.usteer[0];
};

test("the roaming explainers quote what the access points are given", (t) => {
  for (const steering of steeringLevels) {
    const intent = sample();
    intent.wifi.roaming = { steering, prefer_5g: true };
    const usteer = usteerOn(intent);
    const assistance = explainFor(["wifi", "networks", "0", "roaming", "assisted"], intent)!;
    const prefer5g = explainFor(["wifi", "roaming", "prefer_5g"], intent)!;
    // Each threshold the device gets, in the words the UI shows for it.
    if (usteer.roam_trigger_snr !== "0") t.true(assistance.includes(`below ${usteer.roam_trigger_snr} dBm`), steering);
    if (usteer.min_snr !== "0") t.true(assistance.includes(`below ${usteer.min_snr} dBm`), steering);
    t.true(assistance.includes(`${usteer.signal_diff_threshold} dB stronger`) || usteer.roam_trigger_snr === "0", steering);
    t.true(prefer5g.includes(`${usteer.band_steering_min_snr} dBm or better`), steering);
    t.true(prefer5g.includes(`${Number(usteer.band_steering_interval) / 1000} seconds`), steering);
    t.is(prefer5g.includes("disconnected after"), usteer.aggressiveness === "3", steering);
  }
  const off = sample();
  off.wifi.networks[0].roaming.assisted = false;
  off.wifi.roaming = { steering: "push", prefer_5g: false };
  t.regex(explainFor(["wifi", "networks", "0", "roaming", "assisted"], off)!, /Off for this SSID: no neighbour lists/);
});

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? name === "tests"
        ? []
        : sources(path)
      : /\.tsx?$/.test(name)
      ? [path]
      : [];
  });

test("text points to a page by places.ts, never by a hand-written name", (t) => {
  // "Wi-Fi › Radios" written out would go stale when a page is renamed:
  // build it with where("radios"). LuCI's own menus are not ours.
  const ours = [...new Set(Object.values(places).map((p) => p[0]))].map((n) =>
    n.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")
  );
  const pointer = new RegExp(`["\`'][^"\`'\\n]*\\b(${ours.join("|")}) › `);
  const offenders = [...sources(join(root, "src")), ...sources(join(root, "ui", "src"))]
    .filter((path) => !path.endsWith("places.ts"))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${path.slice(root.length + 1)}:${i + 1}` }))
        .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && !line.includes("LuCI:") && pointer.test(line))
        .map(({ at }) => at)
    );
  t.deepEqual(offenders, []);
});
