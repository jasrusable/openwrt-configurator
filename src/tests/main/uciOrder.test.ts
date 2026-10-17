// The order configs, types and options are written in, pinned: what devices
// hold today was written in this order, and `reload_config` compares `uci
// show`, so a mere reordering would reload every service on the next apply.
// Changing an order here is a deliberate step, never a side effect.
import test from "ava";
import { orderConfigs, orderOptions, orderTypes } from "../../plan/uciOrder";

const keysOf = (o: object) => Object.keys(o);
const reversed = (names: string[], extra: string[] = []) =>
  Object.fromEntries([...extra, ...[...names].reverse()].map((name) => [name, 1]));

const options: Record<string, string[]> = {
  "system.system": ["hostname", "timezone"],
  "network.switch": ["name", "reset", "enable_vlan"],
  "network.switch_vlan": ["device", "vlan", "ports"],
  "network.device": ["name", "type", "ports", "mtu", "ipv6"],
  "network.bridge-vlan": ["device", "vlan", "ports"],
  "network.interface": ["device", "proto", "ipaddr", "netmask"],
  "firewall.defaults": ["input", "output", "forward", "synflood_protect"],
  "firewall.zone": ["name", "input", "output", "forward", "masq", "mtu_fix", "network"],
  "firewall.forwarding": ["src", "dest"],
  "firewall.rule": ["enabled", "name", "proto", "icmp_type", "src", "src_ip", "dest", "dest_port", "dest_ip", "family", "target", "limit"],
  "firewall.redirect": ["name", "enabled", "target", "src", "src_ip", "src_dport", "proto", "dest", "dest_ip", "dest_port", "family", "reflection"],
  "dhcp.dnsmasq": [
    "domainneeded", "localise_queries", "rebind_localhost", "local", "expandhosts", "authoritative", "bogusnxdomain",
    "boguspriv", "cachelocal", "cachesize", "dbus", "readethers", "leasefile", "localservice", "ednspacket_max",
    "dnsforwardmax", "domain", "noresolv", "server", "add_local_domain", "add_local_hostname", "add_local_fqdn",
    "add_wan_fqdn", "addnhosts",
  ],
  "dhcp.dhcp": ["interface", "start", "limit", "dhcpv4", "dhcpv6", "ra", "ra_default", "ra_flags", "dns_service", "force", "leasetime"],
  "dhcp.odhcpd": ["maindhcp", "leasefile", "leasetrigger", "loglevel"],
  "wireless.wifi-device": ["type", "path", "phy", "radio", "band", "channel", "htmode"],
  "wireless.wifi-iface": ["device", "mode", "network", "ssid", "encryption", "key", "ifname"],
  "wireless.wifi-station": ["iface", "key", "mac"],
};

test("configs and section types keep the order devices were written in; others follow as declared", (t) => {
  t.deepEqual(keysOf(orderConfigs(reversed(["system", "network", "firewall", "dhcp", "wireless"], ["sqm", "mwan3"]))), [
    "system", "network", "firewall", "dhcp", "wireless", "sqm", "mwan3",
  ]);
  t.deepEqual(
    keysOf(orderTypes("network", reversed(["switch", "switch_vlan", "device", "bridge-vlan", "interface", "rule", "route", "globals"], ["wireguard_vpn"]))),
    ["switch", "switch_vlan", "device", "bridge-vlan", "interface", "rule", "route", "globals", "wireguard_vpn"]
  );
  t.deepEqual(keysOf(orderTypes("firewall", reversed(["defaults", "zone", "forwarding", "rule", "redirect"]))), ["defaults", "zone", "forwarding", "rule", "redirect"]);
  t.deepEqual(keysOf(orderTypes("dhcp", reversed(["dnsmasq", "dhcp", "odhcpd"]))), ["dnsmasq", "dhcp", "odhcpd"]);
  t.deepEqual(keysOf(orderTypes("wireless", reversed(["wifi-device", "wifi-iface", "wifi-station"]))), ["wifi-device", "wifi-iface", "wifi-station"]);
});

test("each modelled type's options keep their order, and options not listed follow as declared", (t) => {
  for (const [at, names] of Object.entries(options)) {
    const [config, type] = at.split(".");
    t.deepEqual(keysOf(orderOptions(config, type, reversed(names, ["zz_extra", "aa_extra"]))), [...names, "zz_extra", "aa_extra"], at);
  }
});
