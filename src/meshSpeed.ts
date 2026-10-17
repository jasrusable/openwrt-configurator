// A mesh link's real speed: batman-adv's throughput meter, run from one node
// to another for a few seconds. On request only (a button), as it sends test
// traffic over the link; it changes nothing.
import { Probe, runProbe } from "./deviceProbes";
import { Platform } from "./platform";
import { fail, Problem } from "./problem";
import { ok, Result } from "./result";
import { onDevice, oneAtATime } from "./status/actions";

/** How long the meter sends for. */
export const meterMs = 5000;

/** batctl's "Throughput: 5.67 MB/s (47.52 Mbps)", in Mbit/s; undefined when it did not say. */
export const parseThroughput = (text: string) => {
  // batctl scales the unit to the value: bps, Kbps, Mbps or Gbps.
  const m = /Throughput:.*\(([\d.]+)\s*([KMG]?)bps\)/i.exec(text);
  if (!m) return undefined;
  const scale = ({ "": 0.000001, K: 0.001, M: 1, G: 1000 } as const)[m[2].toUpperCase() as "" | "K" | "M" | "G"];
  return Math.round(Number(m[1]) * scale * 1e6) / 1e6;
};

/**
 * The node's batman address, which the meter is aimed at: its main
 * interface's MAC, from batctl's header ("MainIF/MAC: mesh0/02:…"), which is
 * not mesh0's when the mesh also runs over cables; else mesh0's.
 */
export const parseMeshAddress = (stdout: string) => {
  const main = /MainIF\/MAC:\s*[^/\s]+\/([0-9a-f:]{17})/i.exec(stdout)?.[1];
  const mesh0 = stdout.split("\n").map((l) => l.trim()).find((l) => /^[0-9a-f:]{17}$/i.test(l));
  return (main ?? mesh0)?.toLowerCase();
};

const meshAddress: Probe<string | undefined> = {
  command: "batctl meshif bat0 originators 2>/dev/null | head -n 1; cat /sys/class/net/mesh0/address 2>/dev/null || true",
  parse: ({ stdout }) => parseMeshAddress(stdout),
};

const meter = (mac: string): Probe<string> => ({
  command: `batctl meshif bat0 throughputmeter -t ${meterMs} ${mac} 2>&1`,
  parse: ({ stdout }) => stdout,
});

/**
 * `from`'s throughput to `to`, like any action (src/status/actions.ts): one at
 * a time, refused while an apply runs, each device within a time limit.
 */
export const measureLink = ({
  intentPath,
  platform,
  from,
  to,
}: {
  intentPath: string;
  platform: Platform;
  from: string;
  to: string;
}): Promise<Result<{ mbps: number }, Problem>> =>
  oneAtATime(platform, intentPath, async () => {
    const mac = await onDevice(intentPath, platform, to, 15_000, async (session) => {
      const found = await runProbe(session, meshAddress);
      return found ? ok(found) : fail("conflict", `${to} is not in the mesh.`);
    });
    if (!mac.ok) return mac;
    return onDevice(intentPath, platform, from, meterMs + 20_000, async (session) => {
      const mbps = parseThroughput(await runProbe(session, meter(mac.value)));
      return mbps === undefined ? fail("failed", "The meter gave no result (is batctl installed?).") : ok({ mbps });
    });
  });
