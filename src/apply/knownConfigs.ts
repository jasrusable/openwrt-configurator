// The UCI configs OpenWrt and its common packages ship, by name. A config a
// run declares must be on the device already, be one of these (a package of
// the run brings it), or be listed as new (`new_configs` in a hand-written
// file): otherwise it is a typo (`firwall`), which would otherwise be staged
// as a config of its own while the real one is wiped as undeclared. A test
// keeps every config the compiler emits in this list.
export const knownConfigs: ReadonlySet<string> = new Set([
  // Base system.
  "system", "network", "wireless", "dhcp", "firewall", "dropbear", "fstab",
  "luci", "rpcd", "ucitrack", "uhttpd", "ubihealthd", "attendedsysupgrade",
  // What this app's features install.
  "mwan3", "sqm", "upnpd", "ddns", "openvpn", "https-dns-proxy", "usteer",
  "nlbwmon", "umdns", "radius", "irqbalance",
  // Common packages a hand-written file may configure.
  "adblock", "banip", "pbr", "travelmate", "acme", "snmpd", "lldpd",
  "collectd", "luci_statistics", "vnstat", "samba4", "ksmbd", "minidlna",
  "ttyd", "watchcat", "zerotier", "tailscale", "wol", "etherwake", "nginx",
  "dockerd", "openssh", "unbound", "stubby", "dnscrypt-proxy", "smartdns",
]);
