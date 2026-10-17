// The networks' rules across settings: one main network, each id, VLAN and
// subnet once, a line or tunnel to keep to that exists, access to networks
// that exist, reservations inside their network, and DNS servers it can reach.
import { vpnZoneIds } from "../access";
import { networkHolding, overlaps, prefixOf } from "../addresses";
import type { FeatureModule } from "../feature";

export const networksChecks: FeatureModule["check"] = (intent, issue) => {
  intent.networks.forEach((network, i) => {
    const via = network.access.via;
    if (via && !intent.internet.lines.some((l) => l.id === via) && !intent.vpn.providers.some((t) => t.id === via)) {
      issue(["networks", i, "access", "via"], "pick a line");
    }
  });
  const untagged = intent.networks.filter((n) => n.vlan === undefined);
  if (untagged.length !== 1) {
    issue(["networks"], "exactly one network must be the main, untagged one");
  }
  intent.networks.forEach((network, i) => {
    const earlier = intent.networks.slice(0, i);
    if (earlier.some((n) => n.id === network.id)) {
      issue(["networks", i, "id"], "already used by another network");
    }
    if (network.vlan !== undefined && earlier.some((n) => n.vlan === network.vlan)) {
      issue(["networks", i, "vlan"], "already used by another network");
    }
    if (earlier.some((n) => overlaps(n.subnet, network.subnet))) {
      issue(["networks", i, "subnet"], "already used by another network");
    }
  });
  const ids = intent.networks.map((n) => n.id);
  // A network's IPv6 interface is its id and 6 (lan6): no other network may be named so.
  intent.networks.forEach((n, i) => {
    if (ids.some((other) => `${other}6` === n.id)) issue(["networks", i, "id"], "reserved");
  });

  // Reservations: inside their network, and each name, MAC and address once.
  const deviceNames = intent.hardware.map((d) => d.name);
  const seen = { name: new Set<string>(), mac: new Set<string>(), address: new Set<string>() };
  intent.networks.forEach((network, i) => {
    const prefix = prefixOf(network.subnet);
    network.dhcp.reservations.forEach((r, j) => {
      const at = (key: string) => ["networks", i, "dhcp", "reservations", j, key];
      const host = Number(r.address.split(".")[3]);
      if (!networkHolding([network], r.address)) {
        issue(at("address"), `an address in ${prefix}.x`);
      } else if (host < 2 || host > 254) {
        issue(at("address"), `${prefix}.2 to ${prefix}.254 (.1 is the router)`);
      }
      if (deviceNames.includes(r.name)) issue(at("name"), "already a device's name");
      (["name", "mac", "address"] as const).forEach((key) => {
        if (seen[key].has(r[key])) issue(at(key), "already used");
        seen[key].add(r[key]);
      });
    });
  });

  // Access names real networks, or the VPN's zones: remote access and sites
  // stay valid targets while off, kept for when they are back.
  intent.networks.forEach((network, i) => {
    network.access.networks.forEach((id) => {
      if (id === network.id) {
        issue(["networks", i, "access", "networks"], "a network always reaches itself");
      } else if (!ids.includes(id) && !vpnZoneIds.includes(id)) {
        issue(["networks", i, "access", "networks"], `no network "${id}"`);
      }
    });
  });
  // A DNS server it hands out on another network must be one it may reach.
  intent.networks.forEach((network, i) =>
    (network.dhcp.dns_servers ?? []).forEach((server, j) => {
      const on = networkHolding(intent.networks, server);
      if (on && on.id !== network.id && !network.access.networks.includes(on.id)) {
        issue(["networks", i, "dhcp", "dns_servers", j], `on ${on.name}, which this network cannot reach: give it access, or pick another`);
      }
    })
  );
};
