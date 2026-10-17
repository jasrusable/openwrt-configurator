// What the Status pages show, worked out from what the devices said
// (device.ts) and the saved settings: what needs attention, who is on the
// network, each device's health and ports, each access point's radios, the
// internet line as the router sees it, and what happened lately in words.
// Pure, like networkStatus: tested against recorded output.
import { compareReleases } from "../release";
import { ClientKind, clientKind } from "./clientKind";
import type { DeviceFacts } from "../deviceFacts";
import { networkHasIpv6 } from "../intent/connections";
import { isPrivateRange } from "../intent/addresses";
import { type Intent } from "../intent/schema";
import { bands } from "../intent/radios";
import { routerBroadcasts } from "../intent/fragment";
import type { DeviceStatus, InternetCheck, PortLink } from "./device";
import { lineWorks, memoryUsed, networkOfAddress, type NetworkStatus, Reachability, readDevices, readOf, reached, routerOf, weakMeshLinkMbps, whyUnread } from "./network";
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
    | {
        kind: "wifi";
        accessPoint: string;
        ssid?: string;
        band?: string;
        channel?: number;
        signal?: number;
        connected?: number;
        /** Mbit/s: the access point's rate to it (tx) and its rate to the access point (rx). */
        txRate?: number;
        rxRate?: number;
        /** Wi-Fi 4, 5, 6 or 7. */
        generation?: number;
      }
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
  /** From the registry (registry.ts): when it was first and last online. */
  firstSeen?: number;
  lastSeen?: number;
  /** First seen within the last day (not a private address). */
  new?: true;
  /** A MAC its device made up (one per network): it may come back as another. */
  private?: true;
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
  /** The services your settings need running there, and whether each is (or is installed at all). */
  services?: { name: string; running: boolean; missing?: boolean }[];
  /** Its log's lines worth reading (links, interfaces, Wi-Fi, mwan3, this app's marks), newest last: each as logged, and in words where it says something (logWords). */
  log?: { at: number; text: string; said?: string; tone?: LogTone }[];
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
  /** Its channel's counters as read (a running total): the collector turns two into `busy`. */
  airtime?: { active: number; busy: number };
  /** How busy its channel was since the last read, %, anyone's traffic counted. */
  busy?: number;
};

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
    d.wifi.flatMap((w) => w.clients.map((c) => ({ ...c, accessPoint: d.hostname, ssid: w.ssid, band: bandOf(w.freq), channel: w.channel })))
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
              ...(air.channel !== undefined ? { channel: air.channel } : {}),
              ...(air.signal !== undefined ? { signal: air.signal } : {}),
              ...(air.connected !== undefined ? { connected: air.connected } : {}),
              ...(air.txRate !== undefined ? { txRate: air.txRate } : {}),
              ...(air.rxRate !== undefined ? { rxRate: air.rxRate } : {}),
              ...(air.generation !== undefined ? { generation: air.generation } : {}),
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

export const devicesOf = (
  intent: Intent,
  devices: Reachability[],
  facts: Record<string, DeviceFacts | undefined>,
  /** The services the settings need running on a device. */
  mustRun: (name: string) => string[] = () => []
): DeviceView[] =>
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
            memoryUsed: memoryUsed(status),
            ...(status.storage ? { storage: status.storage } : {}),
            ...(status.temperature !== undefined ? { temperature: status.temperature } : {}),
            ...(status.cores ? { cores: status.cores } : {}),
            services: mustRun(d.name).map((name) => {
              const stopped = status.notRunning.find((s) => s.name === name);
              return { name, running: !stopped, ...(stopped?.missing ? { missing: true } : {}) };
            }),
            ...(status.log
              ? {
                  log: status.log.slice(-60).map((line) => {
                    const said = logWords(intent, line.text);
                    return said ? { ...line, said: said.text, tone: said.tone } : line;
                  }),
                }
              : {}),
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
      ...(w.airtime ? { airtime: w.airtime } : {}),
    }))
  );

/** The router's Internet checks, when the Performance view read them. */
export const internetOf = (intent: Intent, devices: Reachability[]): InternetCheck | undefined => {
  return reached(routerOf(intent, devices))?.internet;
};

export type LogTone = "up" | "down" | "start" | "problem" | "note";

/**
 * A device's log line in words, where it says something worth telling (as
 * parseLog leaves it: the tag first); undefined for the rest. Read on the
 * device's page, beside the line as logged.
 */
export const logWords = (intent: Intent, text: string): { text: string; tone: LogTone } | undefined => {
  const nameOf = (id: string) =>
    intent.networks.find((n) => n.id === id)?.name ?? intent.internet.lines.find((c) => c.id === id || `${c.id}6` === id)?.name ?? id;
  const upDown = (up: boolean, words: string) => ({ text: words, tone: up ? ("up" as const) : ("down" as const) });
  let m: RegExpExecArray | null;
  if ((m = /netifd: Interface '([^']+)' is now (up|down)/.exec(text))) return upDown(m[2] === "up", `${nameOf(m[1])} ${m[2] === "up" ? "came up" : "went down"}`);
  if ((m = /netifd: Network device '([^']+)' link is (up|down)/.exec(text))) return upDown(m[2] === "up", `Port ${m[1]} ${m[2] === "up" ? "connected" : "disconnected"}`);
  if (/procd: - init complete -/.test(text)) return { text: "Started up", tone: "start" };
  if ((m = /hostapd: (\S+): AP-(ENABLED|DISABLED)/.exec(text))) return upDown(m[2] === "ENABLED", `Wi-Fi ${m[1]} ${m[2] === "ENABLED" ? "on" : "off"}`);
  // mwan3track: "Interface wan (eth1) is offline".
  if ((m = /mwan3\S*: .*interface (\S+)(?: \([^)]*\))? is (online|offline)/i.exec(text)))
    return upDown(m[2].toLowerCase() === "online", `${nameOf(m[1])} is ${m[2].toLowerCase()}`);
  if (/odhcpd.*Failed to send/.test(text)) return { text: "IPv6 announcements are failing", tone: "problem" };
  // This app's own marks, by their syslog tag only: other lines may carry any text, a client's name included.
  if ((m = /^onc(?:-[\w-]+)?(?:\[\d+\])?: (.*)/.exec(text))) return { text: m[1].charAt(0).toUpperCase() + m[1].slice(1), tone: "note" };
  return undefined;
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
            link: "/settings/system/firmware",
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
        link: `/devices/${encodeURIComponent(d.name)}`,
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
    // it has a radio in one of the SSID's bands (when its radios are known);
    // on the router, only when they are known and it broadcasts.
    const radios = facts[d.name]?.schema.radios;
    if (d.role === "access-point" || (routerBroadcasts(intent) && !!radios?.length)) {
      const here = new Set(status.wifi.map((w) => w.ssid));
      const canCarry = (w: Intent["wifi"]["networks"][number]) =>
        !radios || (w.bands ?? bands.filter((b) => intent.wifi.radios[b].enabled)).some((b) => radios.some((r) => r.band === b));
      for (const w of intent.wifi.networks.filter((w) => w.enabled !== false && !here.has(w.ssid) && canCarry(w))) {
        out.push({
          id: `ssid:${d.name}:${w.ssid}`,
          severity: "warning",
          title: `“${w.ssid}” is not on the air at ${d.name}`,
          detail: `Your settings have it there, but ${d.role === "router" ? "the router" : "the access point"} is not broadcasting it.`,
          link: "?apply",
        });
      }
    }
  }
  if (router) {
    const connections = intent.internet.lines;
    const up = connections.filter((c) => lineWorks(router, c.id));
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
        link: "/settings/system/patches",
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
          link: "/settings/internet",
        }]
      : []),
    ...(limit && portUsed && !portIsLine && tagged >= limit.vlans
      ? [{
          id: `vlans:${router.hostname}:${limit.port}`,
          severity: "warning" as const,
          title: `${router.hostname}'s ${limit.port} carries only ${limit.vlans} networks`,
          detail: `Its driver can filter only ${limit.vlans} tagged networks, and ${tagged} are carried there: the rest are missing on that port. Use another port for devices that need them.`,
          link: "/settings/networks",
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
