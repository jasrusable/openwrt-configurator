// The networks, on every device. Each is a VLAN: the main network VLAN 1,
// untagged on every port; the others tagged on every port, so a router port
// is a trunk and an access point plugged in anywhere gets every network.
// The router routes and serves each network (addresses, IPv6, DHCP); every
// other device is a client of the main network and only bridges the rest.
import { tunnelDns } from "../vpn";
import {
  everyDevice,
  Feature,
  gatewayOf,
  isMain,
  mainNetwork,
  Network,
  onAccessPoints,
  onRouter,
  siteSeed,
} from "../fragment";
import { ipv6Interface, networkHasIpv6, primaryConnection } from "../connections";
import { named } from "../names";
import { meshMtu, meshNode } from "./mesh";

/** FNV-1a, 32-bit, as 8 hex digits: a stable value derived from a name. */
export const fnv = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * A stable unique-local IPv6 prefix for the site. RFC 4193 wants the 40-bit
 * global ID random; derived from the site name it is still unlikely to clash,
 * and it never changes unless the name does, without being stored anywhere.
 */
export const ulaPrefix = (siteName: string) => {
  // Two runs give 64 bits, of which 40 are used.
  const hex = fnv(siteName) + fnv(`${siteName}/ula`);
  return `fd${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6, 10)}::/48`;
};

/** The bridge VLAN a network rides on: 1 for the main network. */
const vlanOf = (network: Network) => network.vlan ?? 1;
export const deviceOf = (network: Network) => `br-lan.${vlanOf(network)}`;

/** One per network, so each gets its own /64 of the delegated prefix. */
const ip6hint = (network: Network) => vlanOf(network).toString(16);

const routerInterface = (network: Network, ipv6: boolean, ipv6Upstream: string) => ({
  proto: "static",
  ipaddr: gatewayOf(network),
  netmask: "255.255.255.0",
  ...(ipv6
    ? { ip6assign: "64", ip6hint: ip6hint(network), ip6class: [ipv6Upstream, "local"] }
    : {}),
});

/** The DHCP pool's first host number: it ends at .254, so the low addresses stay free. */
export const poolStart = (network: Pick<Network, "dhcp">) => 255 - network.dhcp.pool_size;

const dhcpServer = (network: Network, ipv6: boolean, tunnelDns: string[] = []) => ({
  force: true,
  start: poolStart(network),
  limit: network.dhcp.pool_size,
  leasetime: network.dhcp.lease,
  dhcpv4: "server",
  ...(ipv6
    ? {
        dhcpv6: "server",
        ra: "server",
        // Announce the router as the IPv6 default route whenever the network
        // has a public prefix, even if odhcpd sees no plain default route (a
        // delegated prefix's is source-specific). Not without one: clients
        // would then try IPv6 internet that is not there.
        ra_default: 1,
        ra_slaac: true,
        ra_flags: ["managed-config", "other-config"],
        // The network's own DNS servers (a Pi-hole): odhcpd must not also
        // announce the router as an IPv6 one, or clients that prefer it go
        // around them. None announced: they use the network's (IPv4) ones.
        ...(network.dhcp.dns_servers?.length ? { dns_service: false } : {}),
      }
    : { dhcpv6: "disabled", ra: "disabled" }),
  // Option 42: the router is the network's time server. Option 6: other DNS
  // servers instead of the router, when the network names them.
  dhcp_option: [
    `42,${gatewayOf(network)}`,
    ...(network.dhcp.dns_servers?.length
      ? [`6,${network.dhcp.dns_servers.join(",")}`]
      : tunnelDns.length
        ? // Out through a provider's tunnel: its DNS, asked through the tunnel too.
          [`6,${tunnelDns.join(",")}`]
        : []),
  ],
});

export const network: Feature = (intent) => {
  const { networks } = intent;
  const main = mainNetwork(intent);
  // A provider's tunnel a network goes out through (its Internet line).
  const tunnelOf = (n: Network) => intent.vpn.providers.find((t) => t.id === n.access.via);
  // A network's IPv6 needs the internet's (without it there is only a local
  // range, announced as if it went somewhere), and not a network out through
  // a provider's tunnel or kept to a line other than the main one: its IPv6
  // would go around it, as IPv6 only has the main's.
  const ipv6 = (n: Network) => networkHasIpv6(intent, n);
  // Prefixes from the main connection's IPv6 interface (wan6 for wan).
  const ipv6Upstream = ipv6Interface(primaryConnection(intent));
  // What a section changes on a mesh node (features/mesh.ts), when the mesh is on.
  // The mesh over cables: the bridge and its ports carry 1532-byte frames
  // (DSA), so each network's own VLAN device is held to 1500, or it would
  // take the bridge's and send its clients frames they cannot take.
  const wiredMesh = intent.wifi.mesh.enabled && intent.wifi.mesh.over_cable && intent.wifi.mesh.large_frames;
  const onMeshNode = (override: Record<string, unknown>) =>
    intent.wifi.mesh.enabled ? { ".overrides": [{ ".if": meshNode(intent), override }] } : {};
  // An access point only carries the networks other than the main one, for
  // its Wi-Fi to join: it has no address on them, and must not have IPv6's
  // link-local one either, or its own services (LuCI, on every address)
  // would answer guests there (verified on 25.12.5: a carried VLAN device
  // gets one unless its device says ipv6 0).
  const carried = (n: Network): { ".overrides"?: { ".if": string; override: Record<string, unknown> }[] } =>
    isMain(n) ? {} : { ".overrides": [{ ".if": onAccessPoints, override: { ipv6: false } }] };
  return {
    services: [
      { ".if": everyDevice, name: "network", running: true },
      // Its reload keeps the devices it had: after a rollback that moved the
      // LAN (br-lan.1 back to br-lan) it sent to one that was gone, and the
      // whole LAN lost IPv6 (seen on a real router). So a rollback restarts it.
      { ".if": onRouter, name: "odhcpd", running: true, restart_after_rollback: true },
    ],
    config: {
      network: {
        // The VLANs, on each kind of switch: DSA bridges VLAN-filter in the
        // bridge; older swconfig switches tag in the switch, one bridge per
        // VLAN. Sections of their own, each for its kind (not an override's
        // list), so other features' (the mesh's backbone) are kept beside them.
        switch: [{ ".if": "device.sw_config == true", name: "switch0", reset: true, enable_vlan: true }],
        switch_vlan: networks.map((n) => ({
          ".if": "device.sw_config == true",
          ".name": `vlan_${vlanOf(n)}`,
          device: "switch0",
          vlan: vlanOf(n),
          ports: isMain(n) ? "*" : "*t",
        })),
        "bridge-vlan": networks.map((n) => ({
          ".if": "device.sw_config == false",
          ".name": `vlan_${vlanOf(n)}`,
          device: "br-lan",
          vlan: vlanOf(n),
          ports: isMain(n) ? "*" : "*t",
        })),
        // The bridges, each for its kind of switch. Sections of their own
        // (not an override's list), so other features' devices (the mesh's)
        // are kept beside them.
        device: [
          // Each network's own VLAN device (DSA), where something is set on
          // it: held to 1500 under the wired mesh's larger frames, and, on
          // access points, no IPv6 on a network only carried (see carried).
          ...networks.flatMap((n) =>
            wiredMesh || !isMain(n)
              ? [
                  {
                    ".if": wiredMesh ? "device.sw_config == false" : `device.sw_config == false AND ${onAccessPoints}`,
                    ".name": `vlandev_${vlanOf(n)}`,
                    name: deviceOf(n),
                    ...(wiredMesh ? { mtu: 1500 } : {}),
                    ...carried(n),
                  },
                ]
              : []
          ),
          ...networks.map((n) => {
            // A mesh node: the mesh in each network's bridge, the main one
            // untagged, as on DSA.
            const meshPorts = intent.wifi.mesh.enabled
              ? [{ ".if": meshNode(intent), override: { ports: [`@cpu_port.${vlanOf(n)}`, isMain(n) ? "bat0" : `bat0.${vlanOf(n)}`] } }]
              : [];
            return {
              ".if": "device.sw_config == true",
              ".name": `bridge_${vlanOf(n)}`,
              name: deviceOf(n),
              type: "bridge",
              ports: [`@cpu_port.${vlanOf(n)}`],
              ".overrides": [...meshPorts, ...(carried(n)[".overrides"] ?? [])],
            };
          }),
          {
            ".if": "device.sw_config == false",
            name: "br-lan",
            type: "bridge",
            ports: "*",
            // The mesh over cables carries batman's larger frames (features/mesh.ts).
            ...(wiredMesh ? { mtu: meshMtu } : {}),
            // A mesh node: the mesh joins the bridge like a port, so the
            // VLANs below carry each network over it as over a cable.
            ...onMeshNode({ ports: ["*", "bat0"] }),
          },
        ],
        interface: [
          {
            ".name": "loopback",
            device: "lo",
            proto: "static",
            ipaddr: "127.0.0.1",
            netmask: "255.0.0.0",
          },
          ...networks.map((n) => ({
            ".name": n.id,
            device: deviceOf(n),
            delegate: false,
            ".overrides": [
              { ".if": onRouter, override: routerInterface(n, ipv6(n), ipv6Upstream) },
              {
                // Access points: a client of the main network; the others
                // only carried, for their Wi-Fi to join.
                ".if": onAccessPoints,
                override: isMain(n) ? { proto: "dhcp", ipv6: false } : { proto: "none" },
              },
            ],
          })),
          ...(ipv6(main)
            ? [
                {
                  ".if": onAccessPoints,
                  ".name": `${main.id}6`,
                  device: deviceOf(main),
                  proto: "dhcpv6",
                  reqprefix: "no",
                },
              ]
            : []),
        ],
        globals: [
          {
            ".name": "globals",
            ".overrides": [
              {
                ".if": onRouter,
                override: {
                  ula_prefix: networks.some(ipv6)
                    ? ulaPrefix(siteSeed(intent))
                    : "",
                },
              },
              { ".if": onAccessPoints, override: { ula_prefix: "" } },
            ],
          },
        ],
      },
      dhcp: {
        dhcp: networks.map((n) => ({
          ".name": n.id,
          interface: n.id,
          ".overrides": [
            { ".if": onRouter, override: dhcpServer(n, ipv6(n), tunnelOf(n) ? tunnelDns(tunnelOf(n)!) : []) },
            {
              ".if": onAccessPoints,
              override: {
                ignore: true,
                dhcpv4: "disabled",
                dhcpv6: "disabled",
                ra: "disabled",
                ndp: "disabled",
              },
            },
          ],
        })),
        // Reservations: the same address every time, and a name in DNS.
        host: named("host", networks.flatMap((n) =>
          n.dhcp.reservations.map((r) => ({
            ".if": onRouter,
            name: r.name,
            mac: r.mac,
            ip: r.address,
            dns: true,
          }))
        ), (h) => h.name),
        odhcpd: [
          {
            ".if": everyDevice,
            ".name": "odhcpd",
            leasefile: "/tmp/odhcpd.leases",
            leasetrigger: "/usr/sbin/odhcpd-update",
            hostsdir: "/tmp/hosts",
            piodir: "/tmp/odhcpd-piodir",
          },
        ],
      },
    },
  };
};
