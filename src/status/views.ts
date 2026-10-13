// What the Status pages show, worked out from what the devices said
// (device.ts) and the saved settings: what needs attention, who is on the
// network, each device's health and ports, each access point's radios, the
// internet line as the router sees it, and what happened lately in words.
// Pure, like networkStatus: tested against recorded output.
import { compareReleases } from "../release";
import { ClientKind, clientKind } from "./clientKind";
import { z } from "zod";
import type { DeviceFacts } from "../deviceFacts";
import { networkHasIpv6 } from "../intent/connections";
import { isPrivateRange } from "../intent/addresses";
import { type Intent } from "../intent/schema";
import { bands } from "../intent/radios";
import type { DeviceStatus, InternetCheck, PortLink } from "./device";
import { networkOfAddress, type NetworkStatus, Reachability, readDevices, readOf, reached, routerOf, weakMeshLinkMbps, whyUnread } from "./network";
import { bandOf } from "./values";
import { droppableFixes } from "../intent/patches/status";


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
  /** What it probably is, for its icon (clientKind.ts). */
  kind?: ClientKind;
  /** Its model, where it says over mDNS (an iPhone's "iPhone15,2"). */
  model?: string;
  ipv4?: string;
  ipv6: string[];
  /** The network it is on, by id: a page names it from the settings it shows. */
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
  /** Asked to reboot and not back yet (src/status/actions.ts). */
  rebooting?: boolean;
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

/** What kind of event: for its icon and the page's filter. */
export const activityKinds = ["up", "down", "start", "apply", "problem", "note"] as const;
export type ActivityKind = (typeof activityKinds)[number];

/** One event in words; also the shape Activity is kept in (src/status/read.ts). Kind is absent on events kept before kinds were. */
export const activityViewSchema = z.object({
  at: z.number(),
  device: z.string(),
  text: z.string(),
  kind: z.enum(activityKinds).optional(),
});
export type ActivityView = z.infer<typeof activityViewSchema>;

/**
 * A service Status may offer to restart: one the settings need running, and
 * not one the link to the device depends on (restarting those has no
 * rollback behind it: applying is the way).
 */
export const restartable = (s: { name: string; running?: boolean; enabled?: boolean }) =>
  !!s.running && s.enabled !== false && !["network", "firewall", "dropbear"].includes(s.name);


/** Who is on the network: the router's leases and neighbours, and every access point's Wi-Fi clients; our own devices left out. */
export const clientsOf = (
  intent: Intent,
  devices: Reachability[],
  facts: Record<string, DeviceFacts | undefined>
): ClientView[] => {
  const router = reached(routerOf(intent, devices));
  const ours = new Set(Object.values(facts).flatMap((f) => f?.macs ?? []));
  const reservations = intent.networks.flatMap((n) => n.dhcp.reservations.map((r) => ({ ...r, mac: r.mac.toLowerCase() })));
  const wifi = readDevices(devices).flatMap((d) =>
    d.wifi.flatMap((w) => w.clients.map((c) => ({ ...c, accessPoint: d.hostname, ssid: w.ssid, band: bandOf(w.freq) })))
  );
  const leases = router?.leases ?? [];
  // Not what is seen on an internet line (the provider's modem): those are not your devices.
  const lineDevices = new Set(
    router
      ? intent.internet.lines.flatMap((c) => router.interfaces.filter((i) => i.id === c.id || i.id === `${c.id}6`).map((i) => i.device))
      : []
  );
  const neighbours = (router?.neighbours ?? []).filter((n) => !n.device || !lineDevices.has(n.device));
  const v6 = router?.ipv6Leases ?? [];
  const heard = router?.mdns ?? [];
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
      const counted = router?.traffic[mac];
      // usteer's own nodes on each access point (another's are "<address>#hostapd…").
      const heardBy = readDevices(devices).flatMap((d) =>
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
      const network = ipv4 ? networkOfAddress(intent, ipv4)?.id : undefined;
      // What it says of itself over mDNS, found by its addresses.
      const said = heard.find((d) => d.addresses.some((a) => a === ipv4 || ipv6.includes(a)));
      // Your own name for it first, then what it calls itself, then what it gave DHCP.
      const name = reservation?.name ?? said?.name ?? lease?.name ?? v6.find((l) => l.mac === mac)?.hostname;
      const kind = clientKind({ mac, name, model: said?.model, services: said?.services });
      return {
        mac,
        ...(name ? { name } : {}),
        ...(kind ? { kind } : {}),
        ...(said?.model ? { model: said.model } : {}),
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
    const read = readOf(devices, d.name);
    const status = reached(read);
    const f = facts[d.name];
    const portNames = (f?.schema.ports ?? []).filter((p) => !p.sw_config_cpu_name).map((p) => p.name);
    return {
      name: d.name,
      role: d.role,
      ...(f?.schema.model ? { model: f.schema.model } : {}),
      ...(f?.schema.version ? { version: f.schema.version } : {}),
      reachable: !!status,
      ...(whyUnread(read) !== undefined ? { error: whyUnread(read) } : {}),
      ...(status
        ? {
            uptime: status.uptime,
            load: status.load[0],
            memoryUsed: status.memory.total ? 1 - status.memory.available / status.memory.total : 0,
            ...(status.storage ? { storage: status.storage } : {}),
            ...(status.temperature !== undefined ? { temperature: status.temperature } : {}),
            ...(status.cores ? { cores: status.cores } : {}),
          }
        : {}),
      ports: portNames.map((name) => status?.links.find((l) => l.name === name) ?? { name, up: false }),
    };
  });

export const radiosOf = (devices: Reachability[]): RadioView[] =>
  readDevices(devices).flatMap((d) =>
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
  return reached(routerOf(intent, devices))?.internet;
};

/** A device's log lines, said in words; lines not worth telling are left out. */
export const activityOf = (intent: Intent, devices: Reachability[]): ActivityView[] => {
  const nameOf = (id: string) =>
    intent.networks.find((n) => n.id === id)?.name ??
    intent.internet.lines.find((c) => c.id === id || `${c.id}6` === id)?.name ??
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
  return readDevices(devices)
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
/** The release batman-adv's 2026.2 fixes reach (merged into routing's openwrt-25.12 after 25.12.5 was tagged). */
export const meshFixesFrom = "25.12.6";

/**
 * What the mesh nodes' releases say (from facts): nodes on different
 * releases can hold their links at the slowest rate (mt76#1066, fixed by
 * matching them), and a release before batman-adv's fixes lacks them.
 */
const meshReleaseHints = (intent: Intent, facts: Record<string, DeviceFacts | undefined>): Attention[] => {
  if (!intent.wifi.mesh.enabled) return [];
  const nodes = intent.hardware.flatMap((d) => {
    const schema = facts[d.name]?.schema;
    const meshes = (schema?.radios ?? []).some((r) => r.band === intent.wifi.mesh.band && r.mesh !== false);
    return schema && meshes ? [{ name: d.name, version: schema.version }] : [];
  });
  const releases = [...new Set(nodes.map((n) => n.version))];
  return [
    ...(releases.length > 1
      ? [
          {
            id: "mesh:releases",
            severity: "warning" as const,
            title: "Mesh nodes run different OpenWrt releases",
            detail: `${nodes.map((n) => `${n.name} ${n.version}`).join(", ")}: links between different releases can fall to the slowest rate (mt76#1066). Run the same release on every node.`,
            link: "/hardware",
          },
        ]
      : []),
    ...(nodes.some((n) => (compareReleases(n.version, meshFixesFrom) ?? 0) < 0)
      ? [
          {
            id: "mesh:batman-fixes",
            severity: "info" as const,
            title: `The mesh's routing gets fixes in OpenWrt ${meshFixesFrom}`,
            detail: `batman-adv's fixes for bridge loop avoidance, multicast and reassembling split packets (which the mesh over cables relies on) come with ${meshFixesFrom} (openwrt/routing#1177); update the mesh nodes when it is out.`,
          },
        ]
      : []),
  ];
};

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
  const router = reached(routerOf(intent, devices));
  for (const d of intent.hardware) {
    const read = readOf(devices, d.name);
    const status = reached(read);
    if (!status) {
      out.push({
        id: `unreachable:${d.name}`,
        severity: "problem",
        title: `${d.name} cannot be reached`,
        detail: whyUnread(read) ?? "It did not answer.",
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
      const canCarry = (w: Intent["wifi"]["networks"][number]) =>
        !radios || (w.bands ?? bands.filter((b) => intent.wifi.radios[b].enabled)).some((b) => radios.some((r) => r.band === b));
      for (const w of intent.wifi.networks.filter((w) => w.enabled !== false && !here.has(w.ssid) && canCarry(w))) {
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
  if (router) {
    const connections = intent.internet.lines;
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
  out.push(...meshReleaseHints(intent, facts));
  // A fix whose every device runs the release that fixed it: the patch can go.
  out.push(
    ...droppableFixes(intent, facts).map(
      (fix): Attention => ({
        id: `fix:droppable:${fix.id}`,
        severity: "info",
        title: `“${fix.title}” is no longer needed`,
        detail: `Every device it applies to runs a release with the fix (${fix.devices.find((d) => d.state === "fixed")?.why}). It does nothing now; the app can drop it (${fix.dropWhen}).`,
        link: "/system/patches",
      })
    )
  );
  if (router) out.push(...routerHints(intent, router, facts[router.hostname]));
  if (applied === "differs") {
    out.push({ id: "apply:pending", severity: "info", title: "Saved settings are not applied yet", detail: "Your devices still run the settings applied before.", link: "?apply" });
  }
  const order = { problem: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
};

/**
 * A port whose driver can filter only a few VLANs: later ones are never
 * created, so the networks they carry are silently missing there. The R6S's
 * 1G port (stmmac, "Timeout accessing MAC_VLAN_Tag_Filter"):
 * https://github.com/openwrt/openwrt/issues/16162, fix in
 * https://github.com/openwrt/openwrt/pull/20279 (open). Every free port
 * carries every network other than the main one tagged, until networks can
 * be assigned per port (TODO.md).
 */
const vlanFilterLimits: Record<string, { port: string; vlans: number }> = {
  "friendlyarm,nanopi-r6s": { port: "eth0", vlans: 3 },
};

/** What the router's own situation makes worth saying: hints, not faults. */
const routerHints = (intent: Intent, router: DeviceStatus, facts: DeviceFacts | undefined): Attention[] => {
  const main = intent.internet.lines[0];
  // UPnP opens ports here, but behind another router (a private address on
  // the line) the internet reaches only that one: STUN finds the outer
  // address, and only a full-cone NAT (or that router's exposed host) passes
  // the ports on.
  const lineAddress = router.interfaces.find((i) => i.id === main?.id)?.ipv4[0]?.split("/")[0];
  const behindNat = !!lineAddress && isPrivateRange(`${lineAddress}/32`);
  const limit = facts && vlanFilterLimits[facts.schema.name];
  const tagged = intent.networks.filter((n) => n.vlan !== undefined).length;
  const portUsed = !!limit && router.links.some((l) => l.name === limit.port && l.up);
  const portIsLine = !!limit && intent.internet.lines.some((l) => l.port === limit.port);
  return [
    ...(intent.internet.upnp && behindNat
      ? [{
          id: "upnp:behind-nat",
          severity: "info" as const,
          title: "UPnP is behind another router",
          detail: `This router's internet address (${lineAddress}) is a private one, so ports opened here reach only the router in front. Make this router its exposed host there, or forward the ports there too.`,
          link: "/internet",
        }]
      : []),
    ...(limit && portUsed && !portIsLine && tagged >= limit.vlans
      ? [{
          id: `vlans:${router.hostname}:${limit.port}`,
          severity: "warning" as const,
          title: `${router.hostname}'s ${limit.port} carries only ${limit.vlans} networks`,
          detail: `Its driver can filter only ${limit.vlans} tagged networks, and ${tagged} are carried there: the rest are missing on that port. Use another port for devices that need them.`,
          link: "/networks",
        }]
      : []),
  ];
};

/** Each internet line's byte counters now, on the router, and when (the server's clock): throughput comes from two reads. */
export const internetCountersOf = (intent: Intent, devices: Reachability[]) => {
  const router = reached(routerOf(intent, devices));
  if (!router) return undefined;
  const lines = Object.fromEntries(
    intent.internet.lines.flatMap((c) => {
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

type MeshNode = NonNullable<NetworkStatus["mesh"]>[number];

/** A mesh node's state in a few words, and whether it is as it should be. */
export const meshNodeState = (node: MeshNode | undefined) => {
  const links = node?.links ?? [];
  const best = Math.max(0, ...links.map((l) => l.throughput));
  if (node?.dropsLargeFrames) return { word: "Cable drops large packets", good: false };
  if (!links.length) return { word: "No link", good: false };
  if (best < weakMeshLinkMbps) return { word: "Weak link", good: false };
  if (node?.fragmentsOverCable) return { word: "Linked, splitting over cable", good: false };
  return { word: "Linked", good: true };
};

/** A WireGuard peer counts as connected within this long of its last handshake (one every 2 minutes while in use). */
export const peerConnectedSeconds = 180;

/** A VPN client's or site's state, from seconds since its last handshake. */
export const peerState = (since: number | undefined) => {
  const connected = since !== undefined && since < peerConnectedSeconds;
  return {
    connected,
    word: connected ? "Connected" : "Away",
    detail: since === undefined ? "never connected" : connected ? "connected" : undefined,
  };
};
