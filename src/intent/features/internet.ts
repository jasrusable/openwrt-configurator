// The router's internet side: each connection (a line on a port), smart
// queueing on each line whose speed is known, and with several lines mwan3
// using them together. The firewall is its own feature (firewall.ts).
import { Feature, mainNetwork, onRouter } from "../fragment";
import { checkOf, Connection, failoverOrder, ipv6Interface, multiWan, primaryConnection, slowLine, stickySeconds } from "../connections";
import { named } from "../names";
import { fnv } from "./network";
import { Intent, lineTypes, netmask } from "../schema";

/**
 * Per-packet overhead by line, as OpenWrt's SQM guidance gives it: fibre is
 * plain Ethernet (cake's "ethernet", "ether-vlan" when tagged), cable is
 * DOCSIS, VDSL the conservative 34 (PTM, PPPoE and a VLAN), ADSL ATM cells.
 */
const lineOverhead = (
  line: (typeof lineTypes)[number],
  tagged: boolean,
): Record<string, unknown> =>
  ({
    fibre: { linklayer: "ethernet", overhead: tagged ? "42" : "38", tcMPU: 84 },
    cable: { linklayer: "ethernet", overhead: "18", tcMPU: 64 },
    vdsl: { linklayer: "ethernet", overhead: "34" },
    adsl: { linklayer: "atm", overhead: "44" },
  })[line];

/**
 * The router's UPnP identity. miniupnpd writes a random one back to UCI when
 * none is set, which the next provision would wipe: derived from the site
 * instead, it stays the same and clients keep seeing the same router.
 */
const upnpUuid = (siteName: string) => {
  const hex = [1, 2, 3, 4].map((n) => fnv(`${siteName}/upnp${n}`)).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

/** A connection's line: its port (unset, the board's WAN port), tagged with its VLAN. */
/** Placeholders the engine resolves: on swconfig, a switch VLAN of the line's own. */
const portOf = (connection: Connection) => (connection.port ? `@port:${connection.port}` : "@wan_port");

/** Each provider's ddns-scripts service name. */
const ddnsServices = { cloudflare: "cloudflare.com-v4", duckdns: "duckdns.org", dynv6: "dynv6.com" } as const;

/** Where the public address is read from: the web, as the WAN may be behind another NAT. */
const ddnsIpUrl = "https://api.ipify.org";

/** The ddns-scripts service for a name that follows the internet address. */
export const ddnsService = (ddns: NonNullable<Intent["internet"]["ddns"]>, wan: string) => {
  // Cloudflare's script takes "record@zone": vpn.home@example.com for
  // vpn.home.example.com in example.com, @example.com for the zone itself.
  const zone = ddns.zone ?? ddns.hostname.split(".").slice(-2).join(".");
  const domain =
    ddns.provider === "cloudflare"
      ? `${ddns.hostname === zone ? "" : ddns.hostname.slice(0, -(zone.length + 1))}@${zone}`
      : ddns.hostname;
  return {
    ".name": "main",
    enabled: true,
    service_name: ddnsServices[ddns.provider],
    lookup_host: ddns.hostname,
    domain,
    username: ddns.provider === "cloudflare" ? "Bearer" : ddns.provider === "duckdns" ? "NA" : "none",
    password: ddns.token,
    use_https: true,
    cacert: "/etc/ssl/certs",
    ip_source: "web",
    ip_url: ddnsIpUrl,
    // The main connection's: ddns-scripts restarts with it.
    interface: wan,
    use_ipv6: false,
    check_interval: 10,
    check_unit: "minutes",
    force_interval: 72,
    force_unit: "hours",
  };
};

export const internet: Feature = (intent) => {
  const { connections, mode, upnp } = intent.internet;
  const main = mainNetwork(intent);
  const several = multiWan(intent);
  // Only with the provider's DNS are the resolvers it hands out used.
  const peerdns = intent.dns.upstream.type === "provider";
  const routerOnly = (sections: Record<string, unknown>[]) =>
    sections.map((section) => ({ ".if": onRouter, ...section }));

  const interfaces = connections.flatMap((c, i) => {
    const { connection, vlan, ipv6_prefix } = c;
    // Only the main connection's IPv6: the networks take their prefixes from it.
    const ipv6 = i === 0 && c.ipv6;
    const proto =
      connection.type === "pppoe"
        ? {
            proto: "pppoe",
            username: connection.username,
            password: connection.password,
            // IPv6CP only: the IPv6 interface below asks for the prefix, at the size wanted.
            ipv6: ipv6 ? "1" : false,
          }
        : connection.type === "static"
          ? {
              proto: "static",
              ipaddr: connection.address,
              netmask: netmask(connection.prefix_length),
              gateway: connection.gateway,
              ...(connection.dns?.length ? { dns: connection.dns } : {}),
            }
          : { proto: "dhcp" };
    return [
      {
        ".name": c.id,
        // A tagged line: netifd makes the VLAN device from the name.
        device: vlan ? `${portOf(c)}.${vlan}` : portOf(c),
        ...(connection.type === "static" ? {} : { peerdns }),
        // Several default routes need distinct metrics (mwan3 then chooses).
        ...(several ? { metric: (i + 1) * 10 } : {}),
        ...proto,
      },
      ...(ipv6
        ? [
            {
              ".name": ipv6Interface(c),
              device: `@${c.id}`,
              proto: "dhcpv6",
              peerdns,
              ...(ipv6_prefix === "auto" ? {} : { reqprefix: ipv6_prefix }),
            },
          ]
        : []),
    ];
  });

  const queue = (c: Connection) => {
    const { speed, vlan, id } = c;
    const ptm = speed?.line === "vdsl" ? " ptm" : "";
    return speed
      ? {
          ".name": id,
          enabled: true,
          // The port itself, so the overhead counts every header on it.
          interface: portOf(c),
          download: String(Math.round(speed.down_mbps * 1000)),
          upload: String(Math.round(speed.up_mbps * 1000)),
          qdisc: "cake",
          script: "piece_of_cake.qos",
          linklayer_advanced: "1",
          ...lineOverhead(speed.line, vlan !== undefined),
          // Fair per device behind the NAT; "ingress" counts what cake
          // drops too, so the download rate holds. VDSL2's 64/65
          // encoding is "ptm". The flags only make LuCI show them.
          qdisc_advanced: "1",
          qdisc_really_really_advanced: "1",
          iqdisc_opts: `nat dual-dsthost ingress${ptm}`,
          eqdisc_opts: `nat dual-srchost${ptm}`,
        }
      : { ".name": id, enabled: false, interface: portOf(c) };
  };

  // Several lines: mwan3 pings out of each and routes IPv4 over those that
  // answer, by policy: the internet's (in order for failover, by weight for
  // sharing, a metered line only as a last resort), and one per network that
  // keeps to a line. IPv6 is left on the main line's own route. Members are
  // a line at a metric and weight, named by them, made as policies need them.
  const members = new Map<string, Record<string, unknown>>();
  const member = (c: Connection, metric: number, weight = 1) => {
    const name = `${c.id}_m${metric}${weight > 1 ? `w${weight}` : ""}`;
    members.set(name, { ".name": name, interface: c.id, metric, weight });
    return name;
  };
  const internetPolicy = connections.map((c) =>
    mode === "failover" ? member(c, failoverOrder(connections).indexOf(c) + 1) : c.metered ? member(c, 2) : member(c, 1, c.weight)
  );
  const byNetwork = intent.networks.flatMap((n) => {
    const line = n.line && connections.find((c) => c.id === n.line!.connection);
    if (!line) return [];
    const others = connections.filter((c) => c !== line);
    return [
      {
        network: n,
        use: [member(line, 1), ...(n.line!.fallback ? others.map((c, j) => member(c, j + 2)) : [])],
      },
    ];
  });
  const perDevice = mode === "balance" && intent.internet.share_per_device;
  const sticky = { sticky: true, timeout: stickySeconds };
  const mwan3 = several
    ? {
        globals: routerOnly([{ ".name": "globals", mmx_mask: "0x3F00" }]),
        interface: routerOnly(
          connections.map((c) => {
            const check = checkOf(c);
            return {
              ".name": c.id,
              enabled: true,
              family: "ipv4",
              initial_state: "online",
              track_method: "ping",
              track_ip: [...check.ips],
              reliability: check.reliability,
              count: c.down_when_slow ? slowLine.count : 1,
              timeout: check.timeoutS,
              interval: check.intervalS,
              down: check.missesDown,
              up: check.missesDown,
              ...(c.down_when_slow
                ? {
                    check_quality: true,
                    failure_latency: slowLine.failMs,
                    failure_loss: slowLine.failLossPct,
                    recovery_latency: slowLine.recoverMs,
                    recovery_loss: slowLine.recoverLossPct,
                  }
                : {}),
            };
          })
        ),
        member: routerOnly([...members.values()]),
        policy: routerOnly([
          { ".name": "internet", use_member: internetPolicy, last_resort: "unreachable" },
          ...byNetwork.map(({ network, use }) => ({ ".name": `via_${network.id}`, use_member: use, last_resort: "unreachable" })),
        ]),
        rule: routerOnly([
          // A network keeping to a line, by its addresses.
          ...byNetwork.map(({ network }) => ({
            ".name": `net_${network.id}`,
            src_ip: network.subnet,
            use_policy: `via_${network.id}`,
            family: "ipv4",
          })),
          // Shared lines: a site sees one address for a whole HTTPS session
          // (a bank logs out a client whose address changes); per device,
          // each device keeps to one line for everything.
          ...(mode === "balance" && !perDevice
            ? [{ ".name": "https", proto: "tcp", dest_port: "443", ...sticky, use_policy: "internet", family: "ipv4" }]
            : []),
          {
            ".name": "default",
            dest_ip: "0.0.0.0/0",
            use_policy: "internet",
            family: "ipv4",
            ...(perDevice ? sticky : {}),
          },
        ]),
      }
    : undefined;

  return {
    package_profiles: [
      {
        ".if": onRouter,
        // Installed whether used or not: a setting changes config, not packages.
        packages: [
          "sqm-scripts",
          "luci-app-sqm",
          "miniupnpd-nftables",
          "luci-app-upnp",
          // A name that follows the address: the providers offered (choices).
          "ddns-scripts",
          "ddns-scripts-services",
          "ddns-scripts-cloudflare",
        ],
      },
      // The exception: mwan3 brings iptables, ipset and their kernel modules
      // (23 packages on 25.12), too much for every router with one line.
      ...(several ? [{ ".if": onRouter, packages: ["mwan3"] }] : []),
    ],
    services: [
      // sqm sets up queues and exits; miniupnpd runs only when UPnP is on.
      { ".if": onRouter, name: "sqm" },
      { ".if": onRouter, name: "miniupnpd", running: upnp },
      ...(several ? [{ ".if": onRouter, name: "mwan3", running: true }] : []),
      { ".if": onRouter, name: "ddns", running: !!intent.internet.ddns },
    ],
    config: {
      network: { interface: routerOnly(interfaces) },
      // As stock: no DHCP served on an internet line.
      dhcp: { dhcp: routerOnly(connections.map((c) => ({ ".name": c.id, interface: c.id, ignore: true }))) },
      // Declared on or off: with its section missing, miniupnpd's init script
      // defaults to enabled. Its firewall hooks are nftables.d includes.
      upnpd: {
        upnpd: routerOnly([
          {
            ".name": "config",
            enabled: upnp,
            enable_upnp: true,
            enable_natpmp: true,
            // A device may only open ports to itself.
            secure_mode: true,
            log_output: false,
            internal_iface: main.id,
            port: 5000,
            upnp_lease_file: "/var/run/miniupnpd.leases",
            igdv1: true,
            uuid: upnpUuid(intent.site.name),
          },
        ]),
        perm_rule: routerOnly(named("perm", [
          {
            action: "allow",
            ext_ports: "1024-65535",
            int_addr: main.subnet,
            int_ports: "1024-65535",
            comment: "Main network, high ports",
          },
          {
            action: "deny",
            ext_ports: "0-65535",
            int_addr: "0.0.0.0/0",
            int_ports: "0-65535",
            comment: "Default deny",
          },
        ], (r) => r.comment)),
      },
      sqm: { queue: routerOnly(connections.map(queue)) },
      // Declared on or off: no service is no updating.
      ddns: {
        ddns: routerOnly([{ ".name": "global", upd_privateip: false }]),
        service: routerOnly(intent.internet.ddns ? [ddnsService(intent.internet.ddns, primaryConnection(intent).id)] : []),
      },
      ...(mwan3 ? { mwan3 } : {}),
    },
  };
};
