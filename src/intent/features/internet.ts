// The router's internet side: the WAN connection, the firewall between it and
// the home network, and smart queueing when the line's speed is known.
import { Feature, mainNetwork, onRouter } from "../fragment";

/** OpenWrt's stock WAN rules: DHCP renewal, ping, multicast and IPv6 upkeep. */
const stockWanRules = (main: string) => [
  {
    name: "Allow-DHCP-Renew",
    src: "wan",
    proto: ["udp"],
    dest_port: [68],
    target: "ACCEPT",
    family: "ipv4",
  },
  {
    name: "Allow-Ping",
    src: "wan",
    proto: ["icmp"],
    icmp_type: ["echo-request"],
    family: "ipv4",
    target: "ACCEPT",
  },
  {
    name: "Allow-IGMP",
    src: "wan",
    proto: ["igmp"],
    family: "ipv4",
    target: "ACCEPT",
  },
  {
    name: "Allow-DHCPv6",
    src: "wan",
    proto: ["udp"],
    dest_port: [546],
    family: "ipv6",
    target: "ACCEPT",
  },
  {
    name: "Allow-MLD",
    src: "wan",
    proto: ["icmp"],
    src_ip: ["fe80::/10"],
    icmp_type: ["130/0", "131/0", "132/0", "143/0"],
    family: "ipv6",
    target: "ACCEPT",
  },
  {
    name: "Allow-ICMPv6-Input",
    src: "wan",
    proto: ["icmp"],
    icmp_type: [
      "echo-request",
      "echo-reply",
      "destination-unreachable",
      "packet-too-big",
      "time-exceeded",
      "bad-header",
      "unknown-header-type",
      "router-solicitation",
      "neighbour-solicitation",
      "router-advertisement",
      "neighbour-advertisement",
    ],
    limit: "1000/sec",
    family: "ipv6",
    target: "ACCEPT",
  },
  {
    name: "Allow-ICMPv6-Forward",
    src: "wan",
    dest: "*",
    proto: ["icmp"],
    icmp_type: [
      "echo-request",
      "echo-reply",
      "destination-unreachable",
      "packet-too-big",
      "time-exceeded",
      "bad-header",
      "unknown-header-type",
    ],
    limit: "1000/sec",
    family: "ipv6",
    target: "ACCEPT",
  },
  {
    name: "Allow-IPSec-ESP",
    src: "wan",
    dest: main,
    proto: ["esp"],
    target: "ACCEPT",
  },
  {
    name: "Allow-ISAKMP",
    src: "wan",
    dest: main,
    dest_port: [500],
    proto: ["udp"],
    target: "ACCEPT",
  },
];

/**
 * What a network that may not reach the others still needs from the router:
 * addresses (DHCP, DHCPv6), names (DNS) and IPv6 neighbour discovery.
 */
const routerServices = (zone: string) => [
  {
    name: `${zone}-DHCP`,
    src: zone,
    proto: ["udp"],
    dest_port: [67],
    family: "ipv4",
    target: "ACCEPT",
  },
  {
    name: `${zone}-DHCPv6`,
    src: zone,
    proto: ["udp"],
    dest_port: [547],
    family: "ipv6",
    target: "ACCEPT",
  },
  {
    name: `${zone}-DNS`,
    src: zone,
    proto: ["tcp", "udp"],
    dest_port: [53],
    target: "ACCEPT",
  },
  {
    name: `${zone}-ICMPv6`,
    src: zone,
    proto: ["icmp"],
    icmp_type: [
      "router-solicitation",
      "neighbour-solicitation",
      "neighbour-advertisement",
      "echo-request",
    ],
    family: "ipv6",
    target: "ACCEPT",
  },
];

export const internet: Feature = (intent) => {
  const { connection, ipv6, speed } = intent.internet;
  const { networks } = intent;
  const main = mainNetwork(intent).id;
  // With encrypted DNS the ISP's resolvers must not be used.
  const peerdns = !intent.dns.over_https;
  const routerOnly = (sections: Record<string, unknown>[]) =>
    sections.map((section) => ({ ".if": onRouter, ...section }));

  return {
    package_profiles: speed
      ? [{ ".if": onRouter, packages: ["sqm-scripts", "luci-app-sqm"] }]
      : [],
    config: {
      network: {
        interface: routerOnly([
          {
            ".name": "wan",
            device: "@wan_port",
            peerdns,
            ...(connection.type === "pppoe"
              ? {
                  proto: "pppoe",
                  username: connection.username,
                  password: connection.password,
                  ipv6: ipv6 ? "auto" : false,
                }
              : { proto: "dhcp" }),
          },
          ...(ipv6 && connection.type === "dhcp"
            ? [{ ".name": "wan6", device: "@wan", proto: "dhcpv6", peerdns }]
            : []),
        ]),
      },
      firewall: {
        defaults: routerOnly([
          {
            input: "REJECT",
            output: "ACCEPT",
            forward: "REJECT",
            synflood_protect: true,
            drop_invalid: true,
          },
        ]),
        zone: routerOnly([
          {
            name: "wan",
            input: "REJECT",
            output: "ACCEPT",
            forward: "DROP",
            masq: true,
            mtu_fix: true,
            network: ipv6 && connection.type === "dhcp" ? ["wan", "wan6"] : ["wan"],
          },
          // One zone per network. Trusted networks (allowed to reach the
          // others) may also reach the router itself; the rest only get its
          // services (routerServices).
          ...networks.map((n) => ({
            name: n.id,
            input: n.access.other_networks ? "ACCEPT" : "REJECT",
            output: "ACCEPT",
            forward: "REJECT",
            network: [n.id],
          })),
        ]),
        forwarding: routerOnly(
          networks.flatMap((n) => [
            ...(n.access.internet ? [{ src: n.id, dest: "wan" }] : []),
            ...(n.access.other_networks
              ? networks
                  .filter((other) => other.id !== n.id)
                  .map((other) => ({ src: n.id, dest: other.id }))
              : []),
          ])
        ),
        rule: routerOnly([
          ...stockWanRules(main),
          ...networks
            .filter((n) => !n.access.other_networks)
            .flatMap((n) => routerServices(n.id)),
        ]),
      },
      ...(speed
        ? {
            sqm: {
              queue: routerOnly([
                {
                  ".name": "wan",
                  enabled: true,
                  interface: "@wan_port",
                  download: String(Math.round(speed.down_mbps * 1000)),
                  upload: String(Math.round(speed.up_mbps * 1000)),
                  qdisc: "cake",
                  script: "piece_of_cake.qos",
                  linklayer: "ethernet",
                  overhead: "38",
                  linklayer_advanced: "1",
                  tcMPU: 84,
                },
              ]),
            },
          }
        : {}),
    },
  };
};
