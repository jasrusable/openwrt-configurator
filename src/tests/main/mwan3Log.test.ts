// A line's failover as mwan3 and this app's hook really log it: recorded on
// OpenWrt 25.12.5 by scripts/mwan3-test.sh (RECORD=1), the main line's pings
// dropped, then let through. The device's own filter keeps what Activity
// reads, and Activity says it in words.
import test from "ava";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { logProbe, parseLog } from "../../status/device/log";
import { activityOf } from "../../status/views";
import { sampleIntent } from "../helpers/fixtures";
import { reads } from "../helpers/reads";
import type { DeviceStatus } from "../../status/device";

const recorded = readFileSync(join(__dirname, "../helpers/status/mwan3-failover.txt"), "utf8");

/** The log probe's own filter, run as the device runs it (grep -E), over the recorded lines. */
const filtered = () => {
  const pattern = /grep -E '([^']+)'/.exec(logProbe.command)![1];
  return spawnSync("grep", ["-E", pattern], { input: recorded, encoding: "utf8" }).stdout;
};

test("mwan3's real failover lines pass the device's filter and read as the line going offline and back", (t) => {
  const intent = sampleIntent();
  // The recorded router's main line is `wan`, as the sample's is.
  const line = intent.internet.lines[0];
  t.is(line.id, "wan");
  const kept = filtered();
  t.regex(kept, /Interface wan \(eth1\) is offline/);
  t.notRegex(kept, /Check \(ping\) failed/, "the per-ping noise stays on the device");
  const router = { hostname: "home-router", log: parseLog(kept) } as unknown as DeviceStatus;
  const said = activityOf(intent, reads(router)).map(({ text, kind }) => [text, kind]);
  t.deepEqual(said.filter(([, kind]) => kind === "down"), [[`${line.name} is offline`, "down"]]);
  t.true(said.some(([text, kind]) => text === `${line.name} is online` && kind === "up"));
  t.true(said.some(([text, kind]) => /IPv6 withdrawn until it is back/.test(text ?? "") && kind === "note"), "the hook's own mark");
});
