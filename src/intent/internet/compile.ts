// The router's internet side: each connection (a line on a port), smart
// queueing on each line whose speed is known, and with several lines mwan3
// using them together. The firewall is its own feature (firewall/).
import { Feature, mainNetwork, onRouter, routerOnly, serviceWhen } from "../fragment";
import { named } from "../names";
import { Options, placeholder, Placeholder, section, Value } from "../../plan/types";
import { fnv, siteSeed } from "../site";
import { checkOf, Connection, failoverOrder, ipv6Interface, multiWan, primaryConnection, slowLine, stickySeconds } from "../connections";
import { isPrivateRange, netmask } from "../addresses";
import type { Intent } from "../schema";
import { lineTypes } from "./schema";
import { ddnsCheckMinutes, stunServer } from "./constants";

/**
 * Per-packet overhead by line, as OpenWrt's SQM guidance gives it: fibre is
 * plain Ethernet (cake's "ethernet", "ether-vlan" when tagged), cable is
 * DOCSIS, VDSL the conservative 34 (PTM, PPPoE and a VLAN), ADSL ATM cells.
 */
const lineOverhead = (
  line: (typeof lineTypes)[number],
  tagged: boolean,
  pppoe: boolean,
): Options => {
  // PPPoE's own 8 bytes on an Ethernet line (VDSL's 34 counts them already).
  const extra = pppoe && (line === "fibre" || line === "cable") ? 8 : 0;
  return {
    fibre: { linklayer: "ethernet", overhead: String((tagged ? 42 : 38) + extra), tcMPU: 84 },
    cable: { linklayer: "ethernet", overhead: String(18 + extra), tcMPU: 64 },
    vdsl: { linklayer: "ethernet", overhead: "34" },
    adsl: { linklayer: "atm", overhead: "44" },
  }[line];
};

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

/**
 * A line's port (unset, the board's WAN port), or a VLAN on it, as a
 * placeholder the engine resolves: on swconfig, a switch VLAN of the line's own.
 */
const portOf = (connection: Connection, vlan?: number): Placeholder =>
  connection.port ? placeholder.port(connection.port, vlan) : placeholder.wanPort(vlan);

/** Each provider's ddns-scripts service name. */
const ddnsServices = { cloudflare: "cloudflare.com-v4", duckdns: "duckdns.org", dynv6: "dynv6.com" } as const;


/** Where the public address is read from: the web, as the WAN may be behind another NAT. */
const ddnsIpUrl = "https://api.ipify.org";

/** The ddns-scripts service for a name that follows the internet address. */
export const ddnsService = (ddns: NonNullable<Intent["internet"]["dynamic_dns"]>, wan: string) => {
  // Cloudflare's script takes "record@zone": vpn.home@example.com for
  // vpn.home.example.com in example.com, @example.com for the zone itself.
  const zone = ddns.zone ?? ddns.hostname.split(".").slice(-2).join(".");
  const domain =
    ddns.provider === "cloudflare"
      ? `${ddns.hostname === zone ? "" : ddns.hostname.slice(0, -(zone.length + 1))}@${zone}`
      : ddns.hostname;
  return {
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
    check_interval: ddnsCheckMinutes,
    check_unit: "minutes",
    force_interval: 72,
    force_unit: "hours",
  };
};

/** Whether a line's own address may be a private one: what it gets by DHCP is not known here. */
const mayBePrivate = (line: Connection | undefined) =>
  !!line && (line.type === "dhcp" || (line.type === "static" && isPrivateRange(`${line.static.address}/32`)));

export const internet: Feature = (intent) => {
  const { lines: connections, upnp } = intent.internet;
  const { mode } = intent.internet.use_lines;
  const main = mainNetwork(intent);
  const several = multiWan(intent);
  // Only with the provider's DNS are the resolvers it hands out used.
  const peerdns = intent.dns.upstream.type === "provider";

  const interfaces = connections.flatMap((c, i) => {
    const { vlan } = c;
    const ipv6Prefix = c.ipv6.prefix;
    // Only the main line's IPv6: the networks take their prefixes from it.
    const ipv6 = i === 0 && c.ipv6.enabled;
    const proto =
      c.type === "pppoe"
        ? {
            proto: "pppoe",
            username: c.pppoe.username,
            password: c.pppoe.password,
            // IPv6CP only: the IPv6 interface below asks for the prefix, at the size wanted.
            ipv6: ipv6 ? "1" : false,
          }
        : c.type === "static"
          ? {
              proto: "static",
              ipaddr: c.static.address,
              netmask: netmask(c.static.prefix_length),
              gateway: c.static.gateway,
              ...(c.static.dns?.length ? { dns: c.static.dns } : {}),
            }
          : { proto: "dhcp" };
    return [
      section(
        { name: c.id },
        {
          // A tagged line: netifd makes the VLAN device from the name.
          device: portOf(c, vlan),
          ...(c.type === "static" ? {} : { peerdns }),
          // Several default routes need distinct metrics (mwan3 then chooses).
          ...(several ? { metric: (i + 1) * 10 } : {}),
          ...proto,
        }
      ),
      ...(ipv6
        ? [
            section(
              { name: ipv6Interface(c) },
              {
                // netifd's alias: the IPv6 side of the line's own interface.
                device: `@${c.id}`,
                proto: "dhcpv6",
                peerdns,
                ...(ipv6Prefix === "auto" ? {} : { reqprefix: ipv6Prefix }),
              }
            ),
          ]
        : []),
    ];
  });

  // Where a line is shaped: its port, so the overhead counts every header on
  // it; PPPoE's own device for PPPoE, as cake reads the NAT (for fairness
  // per device) only of plain IP frames, never of PPPoE's (sch_cake.c,
  // cake_update_flowkeys), and the overhead adds the 8 bytes it takes.
  const shapedOn = (c: Connection): Value => (c.type === "pppoe" ? `pppoe-${c.id}` : portOf(c));
  const queue = (c: Connection) => {
    const { shaping: speed, vlan, id } = c;
    const ptm = speed?.medium === "vdsl" ? " ptm" : "";
    return speed
      ? section({ name: id }, {
          enabled: true,
          interface: shapedOn(c),
          download: String(Math.round(speed.down_mbps * 1000)),
          upload: String(Math.round(speed.up_mbps * 1000)),
          qdisc: "cake",
          script: "piece_of_cake.qos",
          linklayer_advanced: "1",
          ...lineOverhead(speed.medium, vlan !== undefined, c.type === "pppoe"),
          // Fair per device behind the NAT; "ingress" counts what cake
          // drops too, so the download rate holds. VDSL2's 64/65
          // encoding is "ptm". The flags only make LuCI show them.
          qdisc_advanced: "1",
          qdisc_really_really_advanced: "1",
          iqdisc_opts: `nat dual-dsthost ingress${ptm}`,
          eqdisc_opts: `nat dual-srchost${ptm}`,
        })
      : section({ name: id }, { enabled: false, interface: shapedOn(c) });
  };

  // Several lines: mwan3 pings out of each and routes IPv4 over those that
  // answer, by policy: the internet's (in order for failover, by weight for
  // sharing, a metered line only as a last resort), and one per network that
  // keeps to a line. IPv6 is left on the main line's own route. Members are
  // a line at a metric and weight, named by them, made as policies need them.
  const members = new Map<string, Options>();
  const member = (c: Connection, metric: number, weight = 1) => {
    const name = `${c.id}_m${metric}${weight > 1 ? `w${weight}` : ""}`;
    members.set(name, { interface: c.id, metric, weight });
    return name;
  };
  const internetPolicy = connections.map((c) =>
    mode === "failover" ? member(c, failoverOrder(connections).indexOf(c) + 1) : c.failover.metered ? member(c, 2) : member(c, 1, c.failover.weight)
  );
  const byNetwork = intent.networks.flatMap((n) => {
    const line = n.access.via && connections.find((c) => c.id === n.access.via);
    if (!line) return [];
    // The rest as fallback, metered last, as for the internet's own failover.
    const others = failoverOrder(connections.filter((c) => c !== line));
    return [
      {
        network: n,
        use: [member(line, 1), ...(n.access.fallback ? others.map((c, j) => member(c, j + 2)) : [])],
      },
    ];
  });
  const perDevice = mode === "balance" && intent.internet.use_lines.sticky_per_device;
  const sticky = { sticky: true, timeout: stickySeconds };
  const mwan3 = several
    ? {
        globals: routerOnly([section({ name: "globals" }, { mmx_mask: "0x3F00" })]),
        interface: routerOnly(
          connections.map((c) => {
            const check = checkOf(c);
            return section({ name: c.id }, {
              enabled: true,
              family: "ipv4",
              initial_state: "online",
              track_method: "ping",
              track_ip: [...check.ips],
              reliability: check.reliability,
              count: c.failover.down_when_slow ? slowLine.count : 1,
              timeout: check.timeoutS,
              interval: check.intervalS,
              down: check.missesDown,
              up: check.missesDown,
              ...(c.failover.down_when_slow
                ? {
                    check_quality: true,
                    failure_latency: slowLine.failMs,
                    failure_loss: slowLine.failLossPct,
                    recovery_latency: slowLine.recoverMs,
                    recovery_loss: slowLine.recoverLossPct,
                  }
                : {}),
            });
          })
        ),
        member: routerOnly([...members].map(([name, options]) => section({ name }, options))),
        policy: routerOnly([
          section({ name: "internet" }, { use_member: internetPolicy, last_resort: "unreachable" }),
          ...byNetwork.map(({ network, use }) => section({ name: `via_${network.id}` }, { use_member: use, last_resort: "unreachable" })),
        ]),
        rule: routerOnly([
          // A network keeping to a line, by its addresses.
          ...byNetwork.map(({ network }) =>
            section({ name: `net_${network.id}` }, { src_ip: network.subnet, use_policy: `via_${network.id}`, family: "ipv4" })
          ),
          // Shared lines: a site sees one address for a whole HTTPS session
          // (a bank logs out a client whose address changes); per device,
          // each device keeps to one line for everything.
          ...(mode === "balance" && !perDevice
            ? [section({ name: "https" }, { proto: "tcp", dest_port: "443", ...sticky, use_policy: "internet", family: "ipv4" })]
            : []),
          section({ name: "default" }, { dest_ip: "0.0.0.0/0", use_policy: "internet", family: "ipv4", ...(perDevice ? sticky : {}) }),
        ]),
      }
    : {
        // One line: mwan3 is installed but off. Declared all the same, so
        // the package's first start (on install, before the config is
        // staged) reads this, not its stock example of four lines and
        // load-balancing rules: nothing to track, nothing to mark.
        globals: routerOnly([section({ name: "globals" }, { mmx_mask: "0x3F00" })]),
        interface: [],
        member: [],
        policy: [],
        rule: [],
      };

  // Several lines, IPv6 from the main one only: while mwan3 has the main
  // line offline (IPv4 to another), its IPv6 interface is taken down, so the
  // networks' prefix and IPv6 default route go and clients use IPv4 over the
  // backup, rather than keep sending IPv6 into the dead line (the router
  // advertises itself on the prefix alone, ra_default 1). Back with the line.
  const mainLine = primaryConnection(intent);
  const ipv6Failover = several && mainLine.ipv6.enabled;
  return {
    ...(ipv6Failover
      ? {
          files: [
            {
              when: onRouter,
              path: "/etc/hotplug.d/iface/17-onc-ipv6-follows-line",
              mode: "0644",
              // mwan3track sends connected/disconnected to every iface hotplug
              // script (seen on 25.12.5: scripts/mwan3-test.sh).
              content: `[ "$INTERFACE" = "${mainLine.id}" ] || exit 0
case "$ACTION" in
  disconnected) logger -t onc-ipv6 "${mainLine.id} is offline: IPv6 withdrawn until it is back"; ifdown ${ipv6Interface(mainLine)} ;;
  # Only if it is down: ifup restarts an interface that is up.
  connected) [ "$(ubus call network.interface.${ipv6Interface(mainLine)} status 2>/dev/null | jsonfilter -e '@.up')" = "true" ] || ifup ${ipv6Interface(mainLine)} ;;
esac
`,
            },
          ],
        }
      : {}),
    packages: [
      {
        when: onRouter,
        // Installed whether used or not: a setting changes config, not packages.
        add: [
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
      // On every router, as every feature's packages are (about 2.1 MiB with
      // its 23 dependencies on 25.12): adding a line is then a config change.
      { when: onRouter, add: ["mwan3"] },
    ],
    services: [
      // sqm sets up queues and exits; miniupnpd runs only when UPnP is on.
      { when: onRouter, name: "sqm" },
      serviceWhen(onRouter, "miniupnpd", upnp),
      // With one line, off: stopped and disabled, as with no config it still
      // marks every packet and keeps four monitors running (verified on 25.12.5).
      serviceWhen(onRouter, "mwan3", several),
      serviceWhen(onRouter, "ddns", !!intent.internet.dynamic_dns),
    ],
    config: {
      network: { interface: routerOnly(interfaces) },
      // As stock: no DHCP served on an internet line.
      dhcp: { dhcp: routerOnly(connections.map((c) => section({ name: c.id }, { interface: c.id, ignore: true }))) },
      // Declared on or off: with its section missing, miniupnpd's init script
      // defaults to enabled. Its firewall hooks are nftables.d includes.
      upnpd: {
        upnpd: routerOnly([
          section({ name: "config" }, {
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
            uuid: upnpUuid(siteSeed(intent)),
            // Behind another router the line's address is a private one,
            // which miniupnpd 2.3.9 refuses to forward to ("Port forwarding
            // is impossible"); STUN finds the outer address, which works
            // behind a full-cone NAT (that router's exposed host). Where the
            // line's address can be private: DHCP, or a private static one.
            // Releases with ext_allow_private_ipv4 (master, not 25.12:
            // https://github.com/openwrt/packages/pull/28644) will want that too.
            ...(mayBePrivate(primaryConnection(intent))
              ? { use_stun: true, stun_host: stunServer.host, stun_port: stunServer.port }
              : { use_stun: false }),
          }),
        ]),
        perm_rule: routerOnly(
          named(
            "perm",
            [
              { action: "allow", ext_ports: "1024-65535", int_addr: main.subnet, int_ports: "1024-65535", comment: "Main network, high ports" },
              { action: "deny", ext_ports: "0-65535", int_addr: "0.0.0.0/0", int_ports: "0-65535", comment: "Default deny" },
            ].map((options) => section({}, options)),
            (r) => String(r.options.comment)
          )
        ),
      },
      sqm: { queue: routerOnly(connections.map(queue)) },
      // Declared on or off: no service is no updating.
      ddns: {
        ddns: routerOnly([section({ name: "global" }, { upd_privateip: false })]),
        service: routerOnly(
          intent.internet.dynamic_dns
            ? [section({ name: "main" }, ddnsService(intent.internet.dynamic_dns, primaryConnection(intent).id))]
            : []
        ),
      },
      mwan3,
    },
  };
};
