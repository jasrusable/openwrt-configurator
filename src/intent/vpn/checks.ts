// The VPN's rules across settings: keys once in use, each id, address and
// port once, ranges that clash with nothing here, and access to networks
// that exist.
import { vpnZoneIds } from "../access";
import { overlaps } from "../addresses";
import type { FeatureModule } from "../feature";
import { isPrivateRange } from "./schema";

export const vpnChecks: FeatureModule["check"] = (intent, issue) => {
  const ids = intent.networks.map((n) => n.id);
  const { remote_access: remote, sites, providers } = intent.vpn;
  if (remote.enabled && !remote.private_key) issue(["vpn", "remote_access", "private_key"], "required");
  if (sites.peers.length && !sites.private_key) issue(["vpn", "sites", "private_key"], "required");
  remote.clients.forEach((client, i) => {
    if (remote.clients.slice(0, i).some((c) => c.host === client.host)) {
      issue(["vpn", "remote_access", "clients", i, "host"], "another client has this address");
    }
  });
  const unique = (list: { id: string }[], path: string[]) =>
    list.forEach((item, i) => {
      if (list.slice(0, i).some((o) => o.id === item.id)) issue([...path, i, "id"], `another has the id ${item.id}`);
    });
  unique(providers, ["vpn", "providers"]);
  unique(remote.clients, ["vpn", "remote_access", "clients"]);
  unique(sites.peers, ["vpn", "sites", "peers"]);
  if (remote.enabled && sites.peers.length && remote.port === sites.port) {
    issue(["vpn", "sites", "port"], "remote access uses this port");
  }
  const clash = remote.enabled && intent.networks.find((n) => overlaps(n.subnet, remote.subnet));
  if (clash) issue(["vpn", "remote_access", "subnet"], `overlaps ${clash.name}'s ${clash.subnet}`);
  const local = [...intent.networks.map((n) => n.subnet), ...(remote.enabled ? [remote.subnet] : [])];
  sites.peers.forEach((site, i) =>
    site.subnets.forEach((range) => {
      const at = ["vpn", "sites", "peers", i, "subnets"];
      // Routed to the site: an internet range would send that traffic there.
      if (!isPrivateRange(range)) return issue(at, `${range} is not a private range`);
      const mine = local.find((l) => overlaps(l, range));
      if (mine) return issue(at, `${range} overlaps this site's ${mine}`);
      const other = sites.peers.slice(0, i).find((p) => p.subnets.some((s) => overlaps(s, range)));
      if (other) issue(at, `${range} overlaps ${other.name}'s`);
    })
  );
  // Remote access's and the sites' access, like a network's: to networks that exist, or the other zone.
  const accessOf = (path: (string | number)[], access: { networks: string[] }, own: string) =>
    access.networks.forEach((id) => {
      if (id === own || (!ids.includes(id) && !vpnZoneIds.includes(id))) issue([...path, "access", "networks"], `no network "${id}"`);
    });
  if (remote.enabled) accessOf(["vpn", "remote_access"], remote.access, "vpn");
  if (sites.peers.length) accessOf(["vpn", "sites"], sites.access, "sites");
};
