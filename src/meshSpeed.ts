// A mesh link's real speed: batman-adv's throughput meter, run from one node
// to another for a few seconds. On request only (a button), as it sends test
// traffic over the link; it changes nothing.
import { readFacts } from "./deviceFacts";
import { Probe, runProbe } from "./deviceProbes";
import { loadOncConfig } from "./loadConfig";
import { locateEach } from "./locate";
import { Platform } from "./platform";
import { provisionableDevices } from "./provisionConfig";

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

export const measureLink = async ({
  intentPath,
  platform,
  from,
  to,
}: {
  intentPath: string;
  platform: Platform;
  from: string;
  to: string;
}): Promise<{ mbps: number } | { error: string }> => {
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const { ready } = provisionableDevices(oncConfig);
  const devices = [from, to].map((name) => ready.find((d) => d.hostname === name));
  if (devices.some((d) => !d)) return { error: "Both must be devices in Hardware." };
  const facts = readFacts(platform, intentPath, [from, to]);
  const [a, b] = await Promise.all(locateEach({ devices: devices as typeof ready, facts, platform }));
  try {
    if (!("session" in a)) return { error: `${from} could not be reached: ${a.error}` };
    if (!("session" in b)) return { error: `${to} could not be reached: ${b.error}` };
    const mac = await runProbe(b.session, meshAddress);
    if (!mac) return { error: `${to} is not in the mesh.` };
    const output = await runProbe(a.session, meter(mac));
    const mbps = parseThroughput(output);
    return mbps === undefined ? { error: "The meter gave no result (is batctl installed?)." } : { mbps };
  } finally {
    if ("session" in a) a.session.dispose();
    if ("session" in b) b.session.dispose();
  }
};
