// WireGuard on the router, as OpenWrt's own guide lays it out: remote
// access ("vpn", a peer per client pinned to its addresses), linked sites
// ("sites", a peer per site with routes to its ranges), and providers' tunnels
// (one interface each, with its own routing table). Networks whose Internet
// line is a tunnel go out through it by policy routing, netifd's own: their
// traffic to the internet looks up the tunnel's table, local destinations
// stay on the main one, and without "use the others when it is down" an
// unreachable rule after it is the kill switch. Zones and the WAN rules are
// the firewall feature's.
import { Feature, onRouter } from "../fragment";
import { ovpnSafeLines } from "../ovpn";
import { clientAddresses, vpnRouterAddresses } from "../vpn";
import type { Intent } from "../schema";

/** A tunnel's routing table: 100 and its number (tun1: 101). */
export const tunnelTable = (id: string) => 100 + Number(id.replace(/\D/g, ""));

/** Mobile carriers' NAT forgets an idle mapping: a packet every 25 s keeps it. */
const keepalive = 25;

type Tunnel = Intent["tunnels"][number];
type WgTunnel = Extract<Tunnel, { type: "wireguard" }>;
type OvpnTunnel = Extract<Tunnel, { type: "openvpn" }>;

/**
 * A provider's .ovpn as given, with what the router needs set last: its own
 * device name (the tunnel's id, for netifd and the firewall), and no routes
 * from the provider (route-nopull): the router routes it, by policy, so a
 * provider can never take its default route; nothing that runs or writes
 * anything (src/intent/ovpn.ts). Login from a file.
 */
export const ovpnFile = (tunnel: Pick<OvpnTunnel, "id" | "config" | "username">) =>
  [
    ...ovpnSafeLines(tunnel.config).filter(
      (line) => !/^\s*(dev|dev-type|auth-user-pass|route-nopull|redirect-gateway|route)\b/.test(line)
    ),
    "",
    "# Set by openwrt-configurator: its own device, no routes from the provider, no scripts.",
    `dev ${tunnel.id}`,
    "dev-type tun",
    "route-nopull",
    "script-security 1",
    ...(tunnel.username ? [`auth-user-pass /etc/openvpn/${tunnel.id}.auth`] : []),
    "",
  ].join("\n");

const endpoint = (hostPort: string) => {
  const at = hostPort.lastIndexOf(":");
  return { endpoint_host: hostPort.slice(0, at).replace(/^\[|\]$/g, ""), endpoint_port: Number(hostPort.slice(at + 1)) };
};

export const vpn: Feature = (intent) => {
  const routerOnly = (sections: Record<string, unknown>[]) => sections.map((s) => ({ ".if": onRouter, ...s }));
  const { vpn: remote, sites, tunnels, networks } = intent;
  const wgTunnels = tunnels.filter((t): t is WgTunnel => t.type === "wireguard");
  const ovpnTunnels = tunnels.filter((t): t is OvpnTunnel => t.type === "openvpn");
  // A network without internet access has no way out, the tunnel's included (firewall.ts).
  const viaTunnel = networks.flatMap((n, i) => {
    const tunnel = tunnels.find((t) => t.id === n.line?.connection);
    return tunnel && n.access.internet ? [{ network: n, tunnel, priority: 100 + i * 2 }] : [];
  });
  const localRanges = [
    ...networks.map((n) => ({ id: n.id, range: n.subnet })),
    ...(remote.enabled ? [{ id: "vpn", range: remote.subnet }] : []),
    ...sites.peers.flatMap((site) => site.subnets.map((range, i) => ({ id: `${site.id}_${i}`, range }))),
  ];
  return {
    // Installed whether used or not: a setting changes config, not packages.
    package_profiles: [{ ".if": onRouter, packages: ["kmod-wireguard", "wireguard-tools", "openvpn-mbedtls"] }],
    services: ovpnTunnels.length ? [{ ".if": onRouter, name: "openvpn", running: true }] : [],
    // The provider's .ovpn and login: root's alone (keys and a password in them).
    files: ovpnTunnels.flatMap((tunnel) => {
      // Read at start only: a changed file needs the tunnel restarted, which
      // happens only when it changed (the engine compares before replacing).
      const restart = `/etc/init.d/openvpn restart ${tunnel.id}`;
      return [
        // The login first: with the .ovpn after it, a new password is in place when either restarts.
        ...(tunnel.username
          ? [
              {
                ".if": onRouter,
                path: `/etc/openvpn/${tunnel.id}.auth`,
                mode: "0600",
                content: `${tunnel.username}\n${tunnel.password ?? ""}\n`,
                run_after: restart,
              },
            ]
          : []),
        { ".if": onRouter, path: `/etc/openvpn/${tunnel.id}.ovpn`, mode: "0600", content: ovpnFile(tunnel), run_after: restart },
      ];
    }),
    config: {
      // Each OpenVPN tunnel run from its file.
      openvpn: {
        openvpn: routerOnly(
          ovpnTunnels.map((tunnel) => ({ ".name": tunnel.id, enabled: true, config: `/etc/openvpn/${tunnel.id}.ovpn` }))
        ),
      },
      network: {
        interface: routerOnly([
          ...(remote.enabled
            ? [
                {
                  ".name": "vpn",
                  proto: "wireguard",
                  private_key: remote.private_key,
                  listen_port: remote.port,
                  addresses: vpnRouterAddresses(intent),
                },
              ]
            : []),
          ...(sites.peers.length
            ? [{ ".name": "sites", proto: "wireguard", private_key: sites.private_key, listen_port: sites.port }]
            : []),
          ...wgTunnels.map((tunnel) => ({
            ".name": tunnel.id,
            proto: "wireguard",
            private_key: tunnel.private_key,
            addresses: [tunnel.address],
            // Its routes in a table of its own: only the networks sent there use it.
            ip4table: tunnelTable(tunnel.id),
          })),
          // OpenVPN makes its device; netifd only puts it in its zone.
          ...ovpnTunnels.map((tunnel) => ({ ".name": tunnel.id, proto: "none", device: tunnel.id })),
        ]),
        // A peer per client: its own addresses only, no route to add.
        wireguard_vpn: routerOnly(
          remote.enabled
            ? remote.clients.map((client) => ({
                ".name": `vpn_${client.id}`,
                description: client.name,
                public_key: client.public_key,
                allowed_ips: clientAddresses(intent, client).map((a, i) => `${a}/${i === 0 ? 32 : 128}`),
                route_allowed_ips: false,
              }))
            : []
        ),
        // A peer per site: its ranges, routed to it.
        wireguard_sites: routerOnly(
          sites.peers.map((site) => ({
            ".name": `site_${site.id}`,
            description: site.name,
            public_key: site.public_key,
            ...(site.endpoint ? endpoint(site.endpoint) : {}),
            allowed_ips: site.subnets,
            route_allowed_ips: true,
            persistent_keepalive: keepalive,
          }))
        ),
        // An OpenVPN tunnel's default route, in its table (it brings none of its own).
        route: routerOnly(
          ovpnTunnels.map((tunnel) => ({
            ".name": `${tunnel.id}_default`,
            interface: tunnel.id,
            target: "0.0.0.0/0",
            table: tunnelTable(tunnel.id),
          }))
        ),
        ...Object.fromEntries(
          wgTunnels.map((tunnel) => [
            `wireguard_${tunnel.id}`,
            routerOnly([
              {
                ".name": `${tunnel.id}_peer`,
                description: tunnel.name,
                public_key: tunnel.peer.public_key,
                ...(tunnel.peer.preshared_key ? { preshared_key: tunnel.peer.preshared_key } : {}),
                ...endpoint(tunnel.peer.endpoint),
                allowed_ips: ["0.0.0.0/0"],
                // Into the tunnel's own table (ip4table), not the main one.
                route_allowed_ips: true,
                persistent_keepalive: keepalive,
              },
            ]),
          ])
        ),
        rule: routerOnly([
          // This site's own ranges by the main table: the other networks,
          // remote access, linked sites. Named, not "everything but the
          // default route": that would also let the plain line's own subnet
          // and any route its DHCP pushed go around the tunnel.
          ...(viaTunnel.length
            ? localRanges.map(({ id, range }) => ({ ".name": `local_${id}`, dest: range, lookup: "main", priority: 90 }))
            : []),
          ...viaTunnel.flatMap(({ network, tunnel, priority }) => [
            { ".name": `via_${network.id}`, src: network.subnet, lookup: tunnelTable(tunnel.id), priority },
            // The kill switch, always: a WireGuard tunnel stays up when its
            // provider is gone, and the provider's DNS is not reachable over
            // the plain line, so falling back would only leak.
            { ".name": `only_${network.id}`, src: network.subnet, action: "unreachable", priority: priority + 1 },
          ]),
        ]),
      },
    },
  };
};
