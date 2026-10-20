// The networks, on every device. Each is a VLAN: the main network VLAN 1,
// untagged on every port; the others tagged on every port, so a router port
// is a trunk and an access point plugged in anywhere gets every network.
// The router routes and serves each network (addresses, IPv6, DHCP); every
// other device is a client of the main network and only bridges the rest.
import { tunnelDns } from "../vpn";
import { everyDevice, Feature, gatewayOf, isMain, mainNetwork, Network, onAccessPoints, onDsa, onRouter, onSwConfig, sendclientid } from "../fragment";
import { named } from "../names";
import { Options, placeholder, section, SectionMeta } from "../../plan/types";
import { when } from "../../plan/when";
import { siteSeed, ulaPrefix } from "../site";
import { ipv6Interface, networkHasIpv6, primaryConnection } from "../connections";
import { meshMtu, meshNode } from "../mesh";

/** The bridge VLAN a network rides on: 1 for the main network. */
const vlanOf = (network: Network) => network.vlan ?? 1;
/**
 * Where odhcpd remembers the prefixes it announced (RFC 9096): after it starts
 * again it announces one that is gone as deprecated, so clients drop
 * addresses that no longer work. On flash, and kept through upgrades: in
 * stock's /tmp a reboot forgets them, and when the ISP gave a new prefix
 * after the router's 25.12.6 flash, clients kept the dead one until they
 * joined the Wi-Fi again. Written only when a prefix comes, changes or goes.
 */
const piodir = "/etc/odhcpd-piodir";

export const deviceOf = (network: Network) => `br-lan.${vlanOf(network)}`;

/** One per network, so each gets its own /64 of the delegated prefix. */
const ip6hint = (network: Network) => vlanOf(network).toString(16);

const routerInterface = (network: Network, ipv6: boolean, ipv6Upstream: string): Options => ({
  proto: "static",
  ipaddr: gatewayOf(network),
  netmask: "255.255.255.0",
  ...(ipv6
    ? { ip6assign: "64", ip6hint: ip6hint(network), ip6class: [ipv6Upstream, "local"] }
    : {}),
});

/** The DHCP pool's first host number: it ends at .254, so the low addresses stay free. */
export const poolStart = (network: Pick<Network, "dhcp">) => 255 - network.dhcp.pool_size;

const dhcpServer = (network: Network, ipv6: boolean, tunnelDns: string[] = []): Options => ({
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
  // What a section changes on a mesh node (mesh/compile.ts), when the mesh is on.
  // The mesh over cables: the bridge and its ports carry 1532-byte frames
  // (DSA), so each network's own VLAN device is held to 1500, or it would
  // take the bridge's and send its clients frames they cannot take.
  const wiredMesh = intent.wifi.mesh.enabled && intent.wifi.mesh.over_cable && intent.wifi.mesh.large_frames;
  const onMeshNode = (options: Options): SectionMeta["overrides"] =>
    intent.wifi.mesh.enabled ? [{ when: meshNode(intent), options }] : [];
  // An access point only carries the networks other than the main one, for
  // its Wi-Fi to join: it has no address on them, and must not have IPv6's
  // link-local one either, or its own services (LuCI, on every address)
  // would answer guests there (verified on 25.12.5: a carried VLAN device
  // gets one unless its device says ipv6 0).
  const carried = (n: Network): NonNullable<SectionMeta["overrides"]> =>
    isMain(n) ? [] : [{ when: onAccessPoints, options: { ipv6: false } }];
  return {
    services: [
      { when: everyDevice, name: "network", running: true },
      // Its reload keeps the devices it had: after a rollback that moved the
      // LAN (br-lan.1 back to br-lan) it sent to one that was gone, and the
      // whole LAN lost IPv6 (seen on a real router). So a rollback restarts it.
      { when: onRouter, name: "odhcpd", running: true, restartAfterRollback: true },
    ],
    // Kept through a flash (piodir, below).
    files: [{ when: onRouter, path: "/lib/upgrade/keep.d/onc-odhcpd", content: `${piodir}/\n` }],
    config: {
      network: {
        // The VLANs, on each kind of switch: DSA bridges VLAN-filter in the
        // bridge; older swconfig switches tag in the switch, one bridge per
        // VLAN. Sections of their own, each for its kind (not an override's
        // list), so other features' (the mesh's backbone) are kept beside them.
        switch: [section({ when: onSwConfig }, { name: placeholder.switchName, reset: true, enable_vlan: true })],
        switch_vlan: networks.map((n) =>
          section(
            { name: `vlan_${vlanOf(n)}`, when: onSwConfig },
            { device: placeholder.switchName, vlan: vlanOf(n), ports: isMain(n) ? placeholder.freePorts : placeholder.freePortsTagged }
          )
        ),
        "bridge-vlan": networks.map((n) =>
          section(
            { name: `vlan_${vlanOf(n)}`, when: onDsa },
            // Every port of the bridge (the mesh's too): the main one untagged.
            { device: "br-lan", vlan: vlanOf(n), ports: isMain(n) ? placeholder.bridgePorts : placeholder.bridgePortsTagged }
          )
        ),
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
                  section(
                    { name: `vlandev_${vlanOf(n)}`, when: wiredMesh ? onDsa : when.all(onDsa, onAccessPoints), overrides: carried(n) },
                    { name: deviceOf(n), ...(wiredMesh ? { mtu: 1500 } : {}) }
                  ),
                ]
              : []
          ),
          ...networks.map((n) => {
            // A mesh node: the mesh in each network's bridge, the main one
            // untagged, as on DSA.
            const meshPorts = onMeshNode({ ports: [placeholder.cpuPort(vlanOf(n)), isMain(n) ? "bat0" : `bat0.${vlanOf(n)}`] }) ?? [];
            return section(
              { name: `bridge_${vlanOf(n)}`, when: onSwConfig, overrides: [...meshPorts, ...carried(n)] },
              { name: deviceOf(n), type: "bridge", ports: [placeholder.cpuPort(vlanOf(n))] }
            );
          }),
          section(
            {
              when: onDsa,
              // A mesh node: the mesh joins the bridge like a port, so the
              // VLANs below carry each network over it as over a cable.
              overrides: onMeshNode({ ports: [placeholder.freePorts, "bat0"] }),
            },
            {
              name: "br-lan",
              type: "bridge",
              ports: placeholder.freePorts,
              // The mesh over cables carries batman's larger frames (mesh/compile.ts).
              ...(wiredMesh ? { mtu: meshMtu } : {}),
            }
          ),
        ],
        interface: [
          section({ name: "loopback" }, { device: "lo", proto: "static", ipaddr: "127.0.0.1", netmask: "255.0.0.0" }),
          ...networks.map((n) =>
            section(
              {
                name: n.id,
                overrides: [
                  { when: onRouter, options: routerInterface(n, ipv6(n), ipv6Upstream) },
                  // Access points: a client of the main network; the others
                  // only carried, for their Wi-Fi to join.
                  { when: onAccessPoints, options: isMain(n) ? { proto: "dhcp", sendclientid, ipv6: false } : { proto: "none" } },
                ],
              },
              { device: deviceOf(n), delegate: false }
            )
          ),
          ...(ipv6(main)
            ? [section({ name: `${main.id}6`, when: onAccessPoints }, { device: deviceOf(main), proto: "dhcpv6", sendclientid, reqprefix: "no" })]
            : []),
        ],
        // No dhcp_default_duid, deliberately: 25.12 makes a random one at
        // first boot (uci-defaults 14_network-generate-duid, only while it is
        // "auto"), which the wipe removes, so the DHCP clients identify by
        // MAC as before 25.12: stable across applies, rollbacks and
        // reflashes. Declaring one would also send it as the DHCPv4
        // client-id (ff + IAID + DUID), the 25.12 change some ISPs refuse
        // (https://github.com/openwrt/openwrt/issues/21671,
        // https://github.com/openwrt/openwrt/issues/22332), and give every
        // device a new lease once, an access point a new address mid-apply.
        // The uci-default runs again on each flash's first boot, though, and
        // its DUID then outlives the boot until an apply wipes it: hence
        // `sendclientid` (below). A stable DUID of our own: TODO.md.
        globals: [
          section(
            {
              name: "globals",
              overrides: [
                { when: onRouter, options: { ula_prefix: networks.some(ipv6) ? ulaPrefix(siteSeed(intent)) : "" } },
                { when: onAccessPoints, options: { ula_prefix: "" } },
              ],
            },
            {}
          ),
        ],
      },
      // The router's alone: access points have neither dnsmasq nor odhcpd
      // (hardware/compile.ts removes them), so nothing there would read it.
      dhcp: {
        dhcp: networks.map((n) =>
          section(
            { name: n.id, when: onRouter },
            { interface: n.id, ...dhcpServer(n, ipv6(n), tunnelOf(n) ? tunnelDns(tunnelOf(n)!) : []) }
          )
        ),
        // Reservations: the same address every time, and a name in DNS.
        host: named(
          "host",
          networks.flatMap((n) =>
            n.dhcp.reservations.map((r) => section({ when: onRouter }, { name: r.name, mac: r.mac, ip: r.address, dns: true }))
          ),
          (h) => String(h.options.name)
        ),
        odhcpd: [
          section(
            { name: "odhcpd", when: onRouter },
            { leasefile: "/tmp/odhcpd.leases", leasetrigger: "/usr/sbin/odhcpd-update", hostsdir: "/tmp/hosts", piodir }
          ),
        ],
      },
    },
  };
};
