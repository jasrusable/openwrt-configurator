// Adding hardware, guided: what is on the network but not in Hardware yet,
// a read of the one the user picks, and taking it on. Nothing is scanned:
// candidates come from the router's DHCP leases and neighbour table, and
// devices seen before (whose facts are kept). Only the device the user picks
// is logged in to, read-only, and never with the admin password: anything on
// the network could be pretending to be an OpenWrt device. It is tried with
// this app's key, then with OpenWrt's default (no root password, which a
// stock device's dropbear accepts with any password). Picking it is the
// trust-on-first-use moment: its host key is recorded then, and taking it on
// keeps its address, MACs and key as facts, so it is found by identity after.
import { z } from "zod";
import { DeviceFacts, listSeen, readFacts, writeFacts } from "./deviceFacts";
import { Probe, runProbes } from "./deviceProbes";
import { DeviceSchema } from "./deviceSchema";
import { deviceSchemaOf, deviceSchemaProbes } from "./getDeviceSchema";
import { Intent } from "./intent/schema";
import { namePattern } from "./intent/validators";
import { knownKey, Located, locateEach, macsProbe, Neighbour } from "./locate";
import { PlanDevice } from "./plan/types";
import { Platform } from "./platform";
import { provisionableDevices, sshConnectOptions } from "./apply/provisionConfig";
import { fail, Problem } from "./problem";
import { map, messageOf, ok, Result } from "./result";
import { loadSettings } from "./settings";
import { shellQuote } from "./shell";
import { Lease } from "./status/device";
import { fileName, read, stateLayout, StoreFiles, StoreKey, tryWrite } from "./store";

export type Candidate = {
  address: string;
  mac?: string;
  /** The name it gave the router's DHCP. */
  name?: string;
  /** Seen before under this name: its facts are still kept. */
  seen?: { hostname: string; model: string; readAt: number };
  /** Named OpenWrt in DHCP, or answering SSH with dropbear: worth a look. */
  likelyOpenWrt: boolean;
};

/**
 * What is on the network and not in Hardware, best first: seen before, then
 * likely OpenWrt, then the rest. Pure.
 */
export const discoverCandidates = ({
  leases,
  neighbours,
  banners = {},
  known,
  seen,
}: {
  leases: Lease[];
  neighbours: Neighbour[];
  /** SSH banners by address, where one was read. */
  banners?: Record<string, string>;
  /** Devices already in Hardware: their names, addresses and MACs. */
  known: { names: string[]; addresses: string[]; macs: string[] };
  /** Facts of devices seen before that are not in Hardware. */
  seen: DeviceFacts[];
}): Candidate[] => {
  const byAddress = new Map<string, Candidate>();
  const add = (address: string, mac?: string, name?: string) => {
    if (known.addresses.includes(address) || (mac && known.macs.includes(mac)) || (name && known.names.includes(name))) return;
    const before = byAddress.get(address);
    byAddress.set(address, { address, likelyOpenWrt: false, ...before, ...(mac ? { mac } : {}), ...(name ? { name } : {}) });
  };
  leases.forEach((l) => add(l.address, l.mac, l.name));
  neighbours.forEach((n) => add(n.address, n.mac));
  const candidates = [...byAddress.values()].map((c) => {
    const was = seen.find((f) => (c.mac && f.macs?.includes(c.mac)) || f.address === c.address);
    return {
      ...c,
      ...(was ? { seen: { hostname: was.hostname, model: was.schema.model ?? was.schema.name, readAt: was.readAt } } : {}),
      likelyOpenWrt: !!was || /^openwrt$/i.test(c.name ?? "") || /dropbear/i.test(banners[c.address] ?? ""),
    };
  });
  const rank = (c: Candidate) => (c.seen ? 0 : c.likelyOpenWrt ? 1 : 2);
  return candidates.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address, undefined, { numeric: true }));
};

/**
 * Every SSH banner among `addresses`, read from the router: all at once
 * (busybox nc, given a second), so a long list costs one second, not one
 * each. Addresses come from other devices' DHCP, so each is quoted.
 */
const banners = (addresses: string[]): Probe<Record<string, string>> => {
  const list = addresses.map(shellQuote).join(" ");
  return {
    command: [
      "d=$(mktemp -d)",
      `for a in ${list}; do nc "$a" 22 </dev/null > "$d/$a" 2>/dev/null & echo $! >> "$d/pids"; done`,
      'sleep 1; kill $(cat "$d/pids") 2>/dev/null',
      `for a in ${list}; do printf '%s ' "$a"; head -c 64 "$d/$a" 2>/dev/null | tr -d '\\r\\n'; echo; done`,
      'rm -rf "$d"',
    ].join("\n"),
    parse: ({ stdout }) =>
      Object.fromEntries(
        stdout.split("\n").flatMap((line) => {
          const [address, ...banner] = line.trim().split(" ");
          return address ? [[address, banner.join(" ")]] : [];
        })
      ),
  };
};

/** What is on the network and not in Hardware, best first; or why it could not be looked at. */
export const discover = async ({
  intentPath,
  platform,
}: {
  intentPath: string;
  platform: Platform;
}): Promise<Result<Candidate[], Problem>> => {
  const loaded = await loadSettings(intentPath, platform);
  if (!loaded.ok) return loaded;
  const { plan, intent } = loaded.value;
  const { ready } = provisionableDevices(plan);
  const names = intent.hardware.map((d) => d.name);
  const facts = readFacts(platform, intentPath, names);
  const seen = Object.values(readFacts(platform, intentPath, listSeen(platform, intentPath).filter((h) => !names.includes(h)))).flatMap(
    (f) => (f ? [f] : [])
  );
  const router = ready.find((d) => d.tags?.role === "router");
  if (!router) return fail("conflict", "There is no router in Hardware to ask.");
  const [found] = locateEach({ devices: [router], facts, platform });
  const r = await found;
  if (!("session" in r)) return fail("unreachable", `The router could not be reached: ${r.error}`);
  try {
    const tables = r.tables ?? { leases: [], neighbours: [] };
    const known = {
      names,
      addresses: [...ready.map((d) => d.ipaddr), ...Object.values(facts).flatMap((f) => (f?.address ? [f.address] : []))],
      macs: Object.values(facts).flatMap((f) => f?.macs ?? []),
    };
    const first = discoverCandidates({ ...tables, known, seen });
    // Who answers SSH like OpenWrt: asked of the router, for these addresses only.
    const asked = first.slice(0, 32).map((c) => c.address).filter((a) => /^[\d.]+$/.test(a));
    const heard = asked.length ? (await runProbes(r.session, { heard: banners(asked) })).heard : {};
    return ok(discoverCandidates({ ...tables, banners: heard, known, seen }));
  } finally {
    r.session.dispose();
  }
};

export type Inspected = {
  address: string;
  schema: DeviceSchema;
  macs: string[];
  /** Its hostname now: "OpenWrt" on a stock device. */
  hostname: string;
  hostKey?: { type: string; key: string };
  /** It let root in without this app's key: OpenWrt's default, open to anyone on the network. */
  openLogin: boolean;
  suggested: { name: string; role: "router" | "access-point" };
};

/** What role a device suits: Wi-Fi makes an access point; a WAN port and no Wi-Fi, a router. */
export const suggestRole = (schema: DeviceSchema): "router" | "access-point" =>
  (schema.radios ?? []).length === 0 && (schema.ports ?? []).some((p) => p.default_role === "wan") ? "router" : "access-point";

/** Its current hostname, unless a stock one; else one from its role, numbered past those taken. */
export const suggestName = (hostname: string, role: "router" | "access-point", taken: string[]) => {
  const clean = hostname.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (clean && clean !== "openwrt" && !taken.includes(clean)) return clean;
  const base = role === "router" ? "router" : "ap";
  for (let n = 1; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
};

/**
 * OpenWrt's default login: root with no password, which its dropbear accepts
 * with any password. Sent only when this app's key is refused; not a secret.
 */
const stockPassword = "openwrt";

const hostnameProbe: Probe<string> = {
  command: "cat /proc/sys/kernel/hostname",
  parse: ({ stdout }) => stdout.trim(),
};
/**
 * Read the device at `address`, read-only: with this app's key, else with
 * OpenWrt's default. Never the admin password.
 */
export const inspect = async ({
  address,
  intent,
  platform,
}: {
  address: string;
  intent: Intent;
  platform: Platform;
}): Promise<Result<Inspected, Problem>> => {
  const tries: NonNullable<PlanDevice["login"]>[] = [
    ...(intent.system.app_login.key ? [{ username: "root", privateKeyPath: intent.system.app_login.key }] : []),
    { username: "root", password: stockPassword },
  ];
  const failures: string[] = [];
  for (const [i, login] of tries.entries()) {
    const at: PlanDevice = { hostname: address, ipaddr: address, tags: {}, login };
    const options = sshConnectOptions({ deviceConfig: at, platform });
    try {
      const session = await platform.connect({ ...options, readyTimeout: 5000 });
      try {
        const read = await runProbes(session, { ...deviceSchemaProbes, hostname: hostnameProbe, macs: macsProbe });
        const schema = deviceSchemaOf(address, read);
        const key = knownKey(platform, options.knownHostsFile!, address);
        const role = suggestRole(schema);
        return ok({
          address,
          schema,
          macs: read.macs,
          hostname: read.hostname,
          ...(key ? { hostKey: { type: key.type, key: key.key } } : {}),
          openLogin: !!tries[i]?.password,
          suggested: { role, name: suggestName(read.hostname, role, intent.hardware.map((d) => d.name)) },
        });
      } finally {
        session.dispose();
      }
    } catch (e) {
      failures.push(messageOf(e));
    }
  }
  return fail("unreachable", `Could not log in to ${address}: ${failures.join("; ")}`);
};

/** An address as the page may give one: an IP address or a name, nothing a shell would read. */
const addressPattern = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;

/** The read of a device picked to add, kept here so adopting uses it and nothing the browser sends. */
export const inspectedKey = (intentPath: string, address: string): StoreKey<Inspected> => ({
  path: `${stateLayout(intentPath).inspected}/${fileName(address)}.json`,
  schema: z.custom<Inspected>((v) => !!v && typeof v === "object" && typeof (v as Inspected).address === "string"),
  format: 1,
});

/** Read the device at `address` (read-only) and keep what it said, for adopting it. */
export const inspectAt = async ({
  intentPath,
  platform,
  address,
}: {
  intentPath: string;
  platform: Platform;
  address: string;
}): Promise<Result<Inspected, Problem>> => {
  if (!addressPattern.test(address)) return fail("invalid", "Give an address, like 10.0.0.143 or ap.lan.");
  const intent = await savedIntent(intentPath, platform);
  if (!intent.ok) return intent;
  const inspected = await inspect({ address, intent: intent.value, platform });
  if (!inspected.ok) return inspected;
  const kept = tryWrite(platform, inspectedKey(intentPath, address), inspected.value);
  return kept.ok ? inspected : fail("internal", `${address} was read, but what it said could not be kept: ${kept.error.message}`);
};

const savedIntent = async (intentPath: string, platform: Platform): Promise<Result<Intent, Problem>> =>
  map(await loadSettings(intentPath, platform), (settings) => settings.intent);

/**
 * Take on an inspected device under `name`: its facts kept, so it is found by
 * identity from now on. Adopting writes the facts locating trusts (address,
 * host key), so never under a name already in Hardware (it would re-pin that
 * device to this one), nor the same box twice under another name.
 */
export const adopt = async ({
  intentPath,
  platform,
  address,
  name,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  address: string;
  name: string;
  now?: () => number;
}): Promise<Result<{ ok: true }, Problem>> => {
  if (!addressPattern.test(address)) return fail("invalid", "Give an address, like 10.0.0.143 or ap.lan.");
  if (!namePattern.test(name) || name.length > 31) return fail("invalid", "A name like ap-2.");
  const intent = await savedIntent(intentPath, platform);
  if (!intent.ok) return intent;
  if (intent.value.hardware.some((d) => d.name === name)) return fail("conflict", `${name} is already in Hardware.`);
  const inspected = read(platform, inspectedKey(intentPath, address));
  if (!inspected) return fail("conflict", "Read the device first.");
  const known = readFacts(platform, intentPath, intent.value.hardware.map((d) => d.name));
  const same = Object.values(known).find(
    (f) =>
      f &&
      ((inspected.hostKey && f.hostKey?.key === inspected.hostKey.key) || (f.macs ?? []).some((mac) => inspected.macs.includes(mac)))
  );
  if (same) return fail("conflict", `This is ${same.hostname}, already in Hardware.`);
  try {
    keepAdopted(platform, intentPath, name, inspected, now());
  } catch (thrown) {
    return fail("internal", `${name} could not be kept: ${messageOf(thrown)}`);
  }
  return ok({ ok: true as const });
};

/** An inspected device's facts, kept under `name`. */
const keepAdopted = (files: StoreFiles, intentPath: string, name: string, inspected: Inspected, now: number) => {
  const located: Omit<Located, "session"> = {
    hostname: name,
    address: inspected.address,
    schema: inspected.schema,
    macs: inspected.macs,
    ...(inspected.hostKey ? { hostKey: inspected.hostKey } : {}),
  };
  writeFacts(files, intentPath, { ...located, readAt: now });
};
