// Rules and port forwards across settings: ends that exist, one IP version
// per rule, and a forward to a device that can answer, on a port taken once
// (the router's own WireGuard ones included).
import { anywhere, internet, router } from "../access";
import { isIpv6, networkHolding, parseIpv4 } from "../addresses";
import type { FeatureModule } from "../feature";
import { gatewayOf } from "../fragment";

/** A port or a range as [from, to]: "8000-8100" and "8080" are the same port twice. */
const range = (ports: string) => {
  const [from, to = from] = ports.split("-").map(Number);
  return [from, to];
};
const overlap = (x: string, y: string) => {
  const [[a1, a2], [b1, b2]] = [range(x), range(y)];
  return a1 <= b2 && b1 <= a2;
};

export const firewallChecks: FeatureModule["check"] = (intent, issue) => {
  const ids = intent.networks.map((n) => n.id);
  const { rules, port_forwards } = intent.firewall;
  rules.forEach((rule, i) => {
    const at = (key: string) => ["firewall", "rules", i, key];
    if (!ids.includes(rule.from) && rule.from !== internet && rule.from !== anywhere) {
      issue(at("from"), "pick a network, the internet or anywhere");
    }
    if (![internet, anywhere, router].includes(rule.to) && !ids.includes(rule.to)) {
      issue(at("to"), "pick a network, the router, the internet or anywhere");
    }
    const addresses = [...(rule.from_addresses ?? []), ...(rule.to_addresses ?? [])];
    if (addresses.some(isIpv6) && addresses.some((a) => !isIpv6(a))) {
      issue(at("to_addresses"), "IPv4 and IPv6 addresses cannot share a rule");
    }
  });
  const { remote_access: remote, sites } = intent.vpn;
  const wireguardPorts = [
    ...(remote.enabled ? [{ name: "Remote access", port: remote.port }] : []),
    ...(sites.peers.length ? [{ name: "Linked sites", port: sites.port }] : []),
  ];
  port_forwards.forEach((forward, i) => {
    const toAddress = ["firewall", "port_forwards", i, "to", "address"];
    const target = networkHolding(intent.networks, forward.to.address);
    // An address that is none is reported at its field.
    if (!target && parseIpv4(forward.to.address) !== undefined) issue(toAddress, "not on any of your networks");
    // The router's own: its admin pages and SSH, open to the internet.
    if (target && forward.to.address === gatewayOf(target)) {
      issue(toAddress, "the router's own address: forward to a device on the network");
    }
    // Into a network that goes out through a VPN provider's tunnel: its
    // replies would take the tunnel (policy routing by source), never
    // reaching whoever called in over the line.
    if (target?.access.via && intent.vpn.providers.some((t) => t.id === target.access.via)) {
      issue(
        toAddress,
        `on ${target.name}, which goes out through a VPN provider: replies would leave through the tunnel, so the forward could never work`
      );
    }
    // A port forward is IPv4's (fw4 redirect, NAT): an IPv6 source would never match.
    if ((forward.from_addresses ?? []).some(isIpv6)) {
      issue(["firewall", "port_forwards", i, "from_addresses"], "IPv4 addresses only: a port forward is IPv4's");
    }
    const clash = port_forwards
      .slice(0, i)
      .some(
        (other) =>
          overlap(other.port, forward.port) &&
          (other.protocol === forward.protocol ||
            other.protocol === "tcp+udp" ||
            forward.protocol === "tcp+udp")
      );
    if (clash) {
      issue(["firewall", "port_forwards", i, "port"], "already forwarded");
    }
    // The router's own WireGuard ports: a forward's DNAT would take their packets first.
    const listener = forward.protocol !== "tcp" && wireguardPorts.find(({ port }) => overlap(String(port), forward.port));
    if (listener) issue(["firewall", "port_forwards", i, "port"], `${listener.name} listens on UDP ${listener.port}`);
  });
};
