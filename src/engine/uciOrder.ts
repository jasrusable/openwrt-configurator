// The order configs, section types and options are written in, for the
// packages this app models. It is the order the engine has always written
// them in (once a side effect of its schemas), kept so the configs a device
// holds read the same from one apply to the next: `reload_config` compares
// `uci show`, so a mere reordering would reload every service. Anything not
// listed keeps the order it was declared in, after those that are.

const configs = ["system", "network", "firewall", "dhcp", "wireless"];

/** Configs in the order devices are given them: those listed, then the rest by name (the Apply page's groups). */
export const byConfigOrder = (a: string, b: string) => {
  const at = (config: string) => (configs.includes(config) ? configs.indexOf(config) : configs.length);
  return at(a) - at(b) || a.localeCompare(b);
};

const types: Record<string, string[]> = {
  system: ["system"],
  network: ["switch", "switch_vlan", "device", "bridge-vlan", "interface", "rule", "route", "globals"],
  firewall: ["defaults", "zone", "forwarding", "rule", "redirect"],
  dhcp: ["dnsmasq", "dhcp", "odhcpd"],
  wireless: ["wifi-device", "wifi-iface", "wifi-station"],
};

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

/** An object's entries with `first` (those present) leading, in that order, then the rest as they were. */
const ordered = <V>(object: Record<string, V>, first: string[] = []): Record<string, V> => ({
  ...Object.fromEntries(first.filter((key) => key in object).map((key) => [key, object[key]])),
  ...Object.fromEntries(Object.entries(object).filter(([key]) => !first.includes(key))),
});

export const orderConfigs = <V>(object: Record<string, V>) => ordered(object, configs);
export const orderTypes = <V>(config: string, object: Record<string, V>) => ordered(object, types[config]);
export const orderOptions = <V>(config: string, type: string, object: Record<string, V>) =>
  ordered(object, options[`${config}.${type}`]);
