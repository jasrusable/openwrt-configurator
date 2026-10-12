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
  Network,
  onAccessPoints,
  onRouter,
} from "../fragment";
import { networkIpv6Applies } from "../choices";
import { internetIpv6, ipv6Interface, primaryConnection } from "../connections";
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
const isMain = (network: Network) => network.vlan === undefined;

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

const dhcpServer = (network: Network, ipv6: boolean, tunnelDns: string[] = []) => ({
  force: true,
  // The pool ends at .254, so the low addresses stay free.
  start: 255 - network.dhcp.size,
  limit: network.dhcp.size,
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
  const main = networks.find(isMain)!;
  // A network's IPv6 needs the internet's: without it there is only a
  // local range, which would be announced as if it went somewhere.
  // A provider's tunnel a network goes out through (its Internet line).
  const tunnelOf = (n: Network) => intent.tunnels.find((t) => t.id === n.line?.connection);
  // Not a network out through a provider's tunnel, or kept to a line other
  // than the main one: its IPv6 would go around it, as IPv6 only has the main's.
  const offMainLine = (n: Network) => !!n.line && n.line.connection !== primaryConnection(intent).id;
  const ipv6 = (n: Network) => networkIpv6Applies(internetIpv6(intent)) && n.ipv6 && !offMainLine(n);
  // Prefixes from the main connection's IPv6 interface (wan6 for wan).
  const ipv6Upstream = ipv6Interface(primaryConnection(intent));
  // What a section changes on a mesh node (features/mesh.ts), when the mesh is on.
  // The mesh over cables: the bridge and its ports carry 1532-byte frames
  // (DSA), so each network's own VLAN device is held to 1500, or it would
  // take the bridge's and send its clients frames they cannot take.
  const wiredMesh = intent.mesh.enabled && intent.mesh.wired && intent.mesh.jumbo;
  const onMeshNode = (override: Record<string, unknown>) =>
    intent.mesh.enabled ? { ".overrides": [{ ".if": meshNode(intent), override }] } : {};
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
          ...(wiredMesh
            ? networks.map((n) => ({ ".if": "device.sw_config == false", ".name": `mtu_${vlanOf(n)}`, name: deviceOf(n), mtu: 1500 }))
            : []),
          ...networks.map((n) => ({
            ".if": "device.sw_config == true",
            ".name": `bridge_${vlanOf(n)}`,
            name: deviceOf(n),
            type: "bridge",
            ports: [`@cpu_port.${vlanOf(n)}`],
            // A mesh node: the mesh in each network's bridge, the main one
            // untagged, as on DSA.
            ...onMeshNode({ ports: [`@cpu_port.${vlanOf(n)}`, isMain(n) ? "bat0" : `bat0.${vlanOf(n)}`] }),
          })),
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
                    ? ulaPrefix(intent.site.name)
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
          n.reservations.map((r) => ({
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
