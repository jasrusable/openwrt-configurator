// What the Status pages show, worked out from what the devices said
// (device.ts) and the saved settings: what needs attention, who is on the
// network, each device's health and ports, each access point's radios, the
// internet line as the router sees it, and what happened lately in words.
// Pure, like networkStatus: tested against recorded output.
import type { DeviceFacts } from "../deviceFacts";
import { networkHasIpv6 } from "../intent/connections";
import { bands, type Intent } from "../intent/schema";
import type { DeviceStatus, InternetCheck, PortLink } from "./device";

type Reached = DeviceStatus;
type Reachability = DeviceStatus | { hostname: string; error: string };
const reached = (r: Reachability | undefined): r is Reached => !!r && !("error" in r);

export type Attention = {
  /** Stable, for keys and for remembering one was seen. */
  id: string;
  severity: "problem" | "warning" | "info";
  title: string;
  detail: string;
  /** A one-click fix: restart this service on this device (only services the settings declare there). */
  fix?: { device: string; service: string; label: string };
  /** Where to change what causes it: a page path, like "/apply" or "/hardware". */
  link?: string;
};

export type ClientView = {
  mac: string;
  name?: string;
  ipv4?: string;
  ipv6: string[];
  /** The network it is on, by name. */
  network?: string;
  connection:
    | { kind: "wifi"; accessPoint: string; ssid?: string; band?: string; signal?: number; connected?: number }
    | { kind: "wired" }
    | { kind: "unknown" };
  /** Online now (on Wi-Fi, or answering on the network), seen lately, or only holding a lease. */
  state: "online" | "recent" | "away";
  /** A fixed address in your settings. */
  reserved: boolean;
  /**
   * Bytes it downloaded and uploaded, and over what: the router's count
   * (nlbwmon, this month so far), else its access point's (since it joined).
   */
  traffic?: { down: number; up: number; over: "month" | "connection" };
  /** Every access point that hears it, how well, and which it is on (usteer): for roaming. */
  heardBy: { accessPoint: string; band?: string; signal?: number; connected: boolean }[];
};

export type DeviceView = {
  name: string;
  role: string;
  model?: string;
  version?: string;
  reachable: boolean;
  error?: string;
  uptime?: number;
  load?: number;
  memoryUsed?: number;
  storage?: { availableKb: number; totalKb: number };
  temperature?: number;
  /** Its physical ports (from its facts), each with its link. */
  ports: PortLink[];
  cores?: number;
};

export type RadioView = {
  accessPoint: string;
  ifname: string;
  ssid?: string;
  band?: string;
  channel?: number;
  htmode?: string;
  txpower?: number;
  noise?: number;
  clients: number;
};

/** What kind of event: for its icon and the page's filter. Absent on events kept before kinds were. */
export type ActivityKind = "up" | "down" | "start" | "apply" | "problem" | "note";
export type ActivityView = { at: number; device: string; text: string; kind?: ActivityKind };

/**
 * A service Status may offer to restart: one the settings need running, and
 * not one the link to the device depends on (restarting those has no
 * rollback behind it: applying is the way).
 */
export const restartable = (s: { name: string; running?: boolean; enabled?: boolean }) =>
  !!s.running && s.enabled !== false && !["network", "firewall", "dropbear"].includes(s.name);

/** The band a frequency is in. */
export const bandOf = (freq?: number) =>
  freq === undefined ? undefined : freq < 3000 ? "2.4 GHz" : freq < 5925 ? "5 GHz" : "6 GHz";

const networkOfAddress = (intent: Intent, address: string) =>
  intent.networks.find((n) => address.startsWith(n.subnet.split(".").slice(0, 3).join(".") + "."));

/** Who is on the network: the router's leases and neighbours, and every access point's Wi-Fi clients; our own devices left out. */
export const clientsOf = (
  intent: Intent,
  devices: Reachability[],
  facts: Record<string, DeviceFacts | undefined>
): ClientView[] => {
  const routerName = intent.hardware.find((d) => d.role === "router")?.name;
  const router = devices.find((d) => d.hostname === routerName);
  const ours = new Set(Object.values(facts).flatMap((f) => f?.macs ?? []));
  const reservations = intent.networks.flatMap((n) => n.reservations.map((r) => ({ ...r, mac: r.mac.toLowerCase() })));
  const wifi = devices.filter(reached).flatMap((d) =>
    d.wifi.flatMap((w) => w.clients.map((c) => ({ ...c, accessPoint: d.hostname, ssid: w.ssid, band: bandOf(w.freq) })))
  );
  const leases = reached(router) ? router.leases : [];
  // Not what is seen on an internet line (the provider's modem): those are not your devices.
  const lineDevices = new Set(
    reached(router)
      ? intent.internet.connections.flatMap((c) => router.interfaces.filter((i) => i.id === c.id || i.id === `${c.id}6`).map((i) => i.device))
      : []
  );
  const neighbours = reached(router) ? router.neighbours.filter((n) => !n.device || !lineDevices.has(n.device)) : [];
  const v6 = reached(router) ? router.ipv6Leases : [];
  const macs = [
    ...new Set([...leases.map((l) => l.mac), ...wifi.map((c) => c.mac), ...neighbours.filter((n) => !n.address.startsWith("fe80")).map((n) => n.mac)]),
  ].filter((mac) => !ours.has(mac));
  return macs
    .map((mac) => {
      const lease = leases.find((l) => l.mac === mac);
      const air = wifi.find((c) => c.mac === mac);
      const seen = neighbours.filter((n) => n.mac === mac);
      const ipv4 = lease?.address ?? seen.find((n) => !n.address.includes(":"))?.address;
      const reservation = reservations.find((r) => r.mac === mac);
      const ipv6 = [
        ...new Set([
          ...v6.filter((l) => l.mac === mac).flatMap((l) => l.addresses),
          ...seen.filter((n) => n.address.includes(":") && !n.address.startsWith("fe80")).map((n) => n.address),
        ]),
      ];
      const active = seen.some((n) => ["REACHABLE", "DELAY", "PROBE"].includes(n.state));
      const counted = reached(router) ? router.traffic[mac] : undefined;
      // usteer's own nodes on each access point (another's are "<address>#hostapd…").
      const heardBy = devices.filter(reached).flatMap((d) =>
        d.heardBy
          .filter((h) => h.mac === mac && !h.node.includes("#"))
          .map((h) => {
            const radio = d.wifi.find((w) => `hostapd.${w.ifname}` === h.node);
            return {
              accessPoint: d.hostname,
              ...(bandOf(radio?.freq) ? { band: bandOf(radio?.freq) } : {}),
              ...(h.signal !== undefined ? { signal: h.signal } : {}),
              connected: h.connected,
            };
          })
      );
      const network = ipv4 ? networkOfAddress(intent, ipv4)?.name : undefined;
      return {
        mac,
        ...(reservation?.name ?? lease?.name ?? v6.find((l) => l.mac === mac)?.hostname
          ? { name: reservation?.name ?? lease?.name ?? v6.find((l) => l.mac === mac)?.hostname }
          : {}),
        ...(ipv4 ? { ipv4 } : {}),
        ipv6,
        ...(network ? { network } : {}),
        connection: air
          ? {
              kind: "wifi" as const,
              accessPoint: air.accessPoint,
              ...(air.ssid ? { ssid: air.ssid } : {}),
              ...(air.band ? { band: air.band } : {}),
              ...(air.signal !== undefined ? { signal: air.signal } : {}),
              ...(air.connected !== undefined ? { connected: air.connected } : {}),
            }
          : seen.length
            ? { kind: "wired" as const }
            : { kind: "unknown" as const },
        state: air || active ? ("online" as const) : seen.length ? ("recent" as const) : ("away" as const),
        reserved: !!reservation,
        ...(counted
          ? { traffic: { down: counted.rx, up: counted.tx, over: "month" as const } }
          : air?.rxBytes !== undefined && air.txBytes !== undefined
            ? { traffic: { down: air.txBytes, up: air.rxBytes, over: "connection" as const } }
            : {}),
        heardBy,
      };
    })
    .sort((a, b) => (a.state === b.state ? (a.name ?? a.mac).localeCompare(b.name ?? b.mac) : a.state === "online" ? -1 : b.state === "online" ? 1 : a.state === "recent" ? -1 : 1));
};

export const devicesOf = (intent: Intent, devices: Reachability[], facts: Record<string, DeviceFacts | undefined>): DeviceView[] =>
  intent.hardware.map((d) => {
    const status = devices.find((s) => s.hostname === d.name);
    const f = facts[d.name];
    const portNames = (f?.schema.ports ?? []).filter((p) => !p.sw_config_cpu_name).map((p) => p.name);
    return {
      name: d.name,
      role: d.role,
      ...(f?.schema.model ? { model: f.schema.model } : {}),
      ...(f?.schema.version ? { version: f.schema.version } : {}),
      reachable: reached(status),
      ...(status && "error" in status ? { error: status.error } : {}),
      ...(reached(status)
        ? {
            uptime: status.uptime,
            load: status.load[0],
            memoryUsed: status.memory.total ? 1 - status.memory.available / status.memory.total : 0,
            ...(status.storage ? { storage: status.storage } : {}),
            ...(status.temperature !== undefined ? { temperature: status.temperature } : {}),
            ...(status.cores ? { cores: status.cores } : {}),
          }
        : {}),
      ports: portNames.map((name) => (reached(status) ? status.links.find((l) => l.name === name) : undefined) ?? { name, up: false }),
    };
  });

export const radiosOf = (devices: Reachability[]): RadioView[] =>
  devices.filter(reached).flatMap((d) =>
    d.wifi.map((w) => ({
      accessPoint: d.hostname,
      ifname: w.ifname,
      ...(w.ssid ? { ssid: w.ssid } : {}),
      ...(bandOf(w.freq) ? { band: bandOf(w.freq) } : {}),
      ...(w.channel !== undefined ? { channel: w.channel } : {}),
      ...(w.htmode ? { htmode: w.htmode } : {}),
      ...(w.txpower !== undefined ? { txpower: w.txpower } : {}),
      ...(w.noise !== undefined ? { noise: w.noise } : {}),
      clients: w.clients.length,
    }))
  );

/** The router's Internet checks, when the Performance view read them. */
export const internetOf = (intent: Intent, devices: Reachability[]): InternetCheck | undefined => {
  const routerName = intent.hardware.find((d) => d.role === "router")?.name;
  const router = devices.find((d) => d.hostname === routerName);
  return reached(router) ? router.internet : undefined;
};

/** A device's log lines, said in words; lines not worth telling are left out. */
export const activityOf = (intent: Intent, devices: Reachability[]): ActivityView[] => {
  const nameOf = (id: string) =>
    intent.networks.find((n) => n.id === id)?.name ??
    intent.internet.connections.find((c) => c.id === id || `${c.id}6` === id)?.name ??
    id;
  const say = (text: string): { text: string; kind: ActivityKind } | undefined => {
    let m: RegExpExecArray | null;
    const upDown = (up: boolean, text: string) => ({ text, kind: up ? ("up" as const) : ("down" as const) });
    if ((m = /netifd: Interface '([^']+)' is now (up|down)/.exec(text))) return upDown(m[2] === "up", `${nameOf(m[1])} ${m[2] === "up" ? "came up" : "went down"}`);
    if ((m = /netifd: Network device '([^']+)' link is (up|down)/.exec(text))) return upDown(m[2] === "up", `Port ${m[1]} ${m[2] === "up" ? "connected" : "disconnected"}`);
    if (/procd: - init complete -/.test(text)) return { text: "Started up", kind: "start" };
    if ((m = /hostapd: (\S+): AP-(ENABLED|DISABLED)/.exec(text))) return upDown(m[2] === "ENABLED", `Wi-Fi ${m[1]} ${m[2] === "ENABLED" ? "on" : "off"}`);
    // mwan3track: "Interface wan (eth1) is offline".
    if ((m = /mwan3\S*: .*interface (\S+)(?: \([^)]*\))? is (online|offline)/i.exec(text)))
      return upDown(m[2].toLowerCase() === "online", `${nameOf(m[1])} is ${m[2].toLowerCase()}`);
    if (/odhcpd.*Failed to send/.test(text)) return { text: "IPv6 announcements are failing", kind: "problem" };
    // This app's own marks, by their syslog tag only (parseLog leaves the
    // tag first): other lines may carry any text, a client's name included.
    if ((m = /^onc(?:-[\w-]+)?(?:\[\d+\])?: (.*)/.exec(text))) return { text: m[1].charAt(0).toUpperCase() + m[1].slice(1), kind: "note" };
    return undefined;
  };
  return devices
    .filter(reached)
    .flatMap((d) =>
      (d.log ?? []).flatMap((line) => {
        const said = say(line.text);
        return said ? [{ at: line.at, device: d.hostname, ...said }] : [];
      })
    )
    .filter((e, i, all) => i === all.findIndex((o) => o.device === e.device && o.text === e.text && Math.abs(o.at - e.at) < 2000))
    .sort((a, b) => b.at - a.at)
    .slice(0, 150);
};

/** What needs attention, worst first: each with what it means, and a fix or a link where there is one. */
export const attentionOf = ({
  intent,
  devices,
  facts,
  applied,
}: {
  intent: Intent;
  devices: Reachability[];
  facts: Record<string, DeviceFacts | undefined>;
  /** Whether the saved settings are what was last applied from here. */
  applied?: "none" | "matches" | "differs";
}): Attention[] => {
  const out: Attention[] = [];
  const routerName = intent.hardware.find((d) => d.role === "router")?.name;
  const router = devices.find((d) => d.hostname === routerName);
  for (const d of intent.hardware) {
    const status = devices.find((s) => s.hostname === d.name);
    if (!reached(status)) {
      out.push({
        id: `unreachable:${d.name}`,
        severity: "problem",
        title: `${d.name} cannot be reached`,
        detail: status && "error" in status ? status.error : "It did not answer.",
        link: "/hardware",
      });
      continue;
    }
    for (const s of status.notRunning) {
      out.push({
        id: `service:${d.name}:${s.name}`,
        severity: "warning",
        title: `${s.name} is ${s.missing ? "not installed" : "not running"} on ${d.name}`,
        detail: s.missing ? "Your settings need it there: applying installs it." : "Your settings need it running.",
        ...(s.missing
          ? { link: "?apply" }
          : restartable({ name: s.name, running: true }) ? { fix: { device: d.name, service: s.name, label: `Restart ${s.name}` } } : {}),
      });
    }
    if (status.unread.length) {
      out.push({
        id: `unread:${d.name}`,
        severity: "info",
        title: `Part of ${d.name}'s status could not be read`,
        detail: `${status.unread.join(", ")}: shown as empty meanwhile.`,
      });
    }
    if (status.storage && (status.storage.availableKb < 2048 || status.storage.availableKb / status.storage.totalKb < 0.1)) {
      out.push({
        id: `storage:${d.name}`,
        severity: "warning",
        title: `${d.name} is nearly out of storage`,
        detail: `${Math.round(status.storage.availableKb / 1024)} MiB free: an apply that installs packages could fail.`,
      });
    }
    if (status.temperature !== undefined && status.temperature >= 85) {
      out.push({ id: `temperature:${d.name}`, severity: "warning", title: `${d.name} is running hot`, detail: `${status.temperature} °C.` });
    }
    if (status.memory.total && status.memory.available / status.memory.total < 0.1) {
      out.push({ id: `memory:${d.name}`, severity: "warning", title: `${d.name} is nearly out of memory`, detail: "Under 10% free." });
    }
    // An SSID of yours that this access point does not broadcast: only where
    // it has a radio in one of the SSID's bands (when its radios are known).
    if (d.role === "access-point") {
      const here = new Set(status.wifi.map((w) => w.ssid));
      const radios = facts[d.name]?.schema.radios;
      const canCarry = (w: Intent["wifi"][number]) =>
        !radios || (w.bands ?? bands.filter((b) => intent.radios[b].enabled)).some((b) => radios.some((r) => r.band === b));
      for (const w of intent.wifi.filter((w) => w.enabled !== false && !here.has(w.ssid) && canCarry(w))) {
        out.push({
          id: `ssid:${d.name}:${w.ssid}`,
          severity: "warning",
          title: `“${w.ssid}” is not on the air at ${d.name}`,
          detail: "Your settings have it there, but the access point is not broadcasting it.",
          link: "?apply",
        });
      }
    }
  }
  if (reached(router)) {
    const connections = intent.internet.connections;
    const up = connections.filter((c) => {
      const line = router.lines.find((l) => l.id === c.id);
      return line ? line.state === "online" || line.state === "disconnecting" : !!router.interfaces.find((i) => i.id === c.id)?.up;
    });
    if (up.length === 0) {
      out.push({ id: "internet:down", severity: "problem", title: "No internet", detail: "No internet connection is working.", link: "/internet" });
    } else {
      for (const c of connections.filter((c) => !up.includes(c))) {
        out.push({
          id: `line:${c.id}`,
          severity: "warning",
          title: `${c.name || "A connection"} is down`,
          detail: `Using ${up.map((u) => u.name || u.id).join(", ")} meanwhile.`,
          link: "/internet",
        });
      }
    }
    // The router stopped announcing IPv6 on a network: clients ask and get
    // no answer. Seen twice on the user's router. Judged over the last few
    // minutes where an earlier count is kept (asked 3 times, nothing sent),
    // else since the interface came up (asked, never once answered), so it
    // clears once fixed. Only networks the compiler gives IPv6.
    {
      const silent = intent.networks.flatMap((n) => {
        if (!networkHasIpv6(intent, n)) return [];
        const device = router.interfaces.find((i) => i.id === n.id)?.device;
        const a = router.adverts.find((x) => x.device === device);
        if (!a) return [];
        const quiet = a.before
          ? a.solicits - a.before.solicits >= 3 && a.sent === a.before.sent
          : a.solicits >= 5 && a.sent === 0;
        return quiet ? [n.name] : [];
      });
      if (silent.length) {
        out.push({
          id: "ipv6:silent",
          severity: "problem",
          title: `No IPv6 on ${silent.join(", ")}`,
          detail: "The router stopped announcing IPv6 there: devices ask and get no answer. Restarting its IPv6 service fixes it.",
          fix: { device: router.hostname, service: "odhcpd", label: "Restart IPv6" },
        });
      }
    }
  }
  if (applied === "differs") {
    out.push({ id: "apply:pending", severity: "info", title: "Saved settings are not applied yet", detail: "Your devices still run the settings applied before.", link: "?apply" });
  }
  const order = { problem: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
};

/** Each internet line's byte counters now, on the router, and when (the server's clock): throughput comes from two reads. */
export const internetCountersOf = (intent: Intent, devices: Reachability[]) => {
  const routerName = intent.hardware.find((d) => d.role === "router")?.name;
  const router = devices.find((d) => d.hostname === routerName);
  if (!reached(router)) return undefined;
  const lines = Object.fromEntries(
    intent.internet.connections.flatMap((c) => {
      const device = router.interfaces.find((i) => i.id === c.id)?.device;
      return device && router.counters[device] ? [[c.id, router.counters[device]] as const] : [];
    })
  );
  return Object.keys(lines).length ? { lines, at: router.readAt } : undefined;
};

/** What was kept from earlier reads, newer first; the same event twice kept once. Logs roll over: this does not. */
export const keepActivity = (kept: ActivityView[], fresh: ActivityView[], limit = 1000): ActivityView[] =>
  [...fresh, ...kept]
    .filter((e, i, all) => i === all.findIndex((o) => o.device === e.device && o.text === e.text && Math.abs(o.at - e.at) < 2000))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
