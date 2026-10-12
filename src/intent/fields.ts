// What each intent setting is called and what it does, for people: the
// provision page explains a change with it. Patterns use * for a list index;
// a pattern for a list item names the item from its value. Where a setting's
// effect depends on others (roaming assistance on Steering), its explainer
// is a function of the intent, and its numbers come from where the compiler
// takes them (roaming.ts), so the text says what the devices will do.
import { lineCheck, meteredCheck, monthlyMegabytes, slowLine, stickySeconds } from "./connections";
import { where } from "./places";
import {
  describePrefer5g,
  describeSteering,
  describeSteeringLevels,
  steeringLabels,
} from "./roaming";
import type { Intent } from "./schema";

export type FieldInfo = {
  path: string;
  label: string | ((item: any) => string);
  description?: string;
  /** Never shown, even in a diff. */
  secret?: boolean;
  unit?: string;
  /** What OpenWrt calls it, for people who know LuCI: the foot of the setting's ⓘ tooltip. */
  openwrt?: string;
  /**
   * What it does on the devices, in more depth than its description: the
   * body of the tooltip. A function when it depends on other settings; `at`
   * holds what each * in the path matched.
   */
  explain?: string | ((intent: Intent, at: string[]) => string);
};

export const fields: FieldInfo[] = [
  { path: "site", label: "System" },
  { path: "site.name", label: "Name" },
  {
    path: "site.timezone",
    label: "Time zone",
    description: "Access points also broadcast it, so clients can set their clocks (802.11v).",
  },
  {
    path: "site.country",
    label: "Country",
    description:
      "Sets which Wi-Fi channels and power levels are allowed; access points announce it to clients (802.11d).",
  },
  { path: "admin", label: "Administration" },
  {
    path: "admin.ssh_key_path",
    label: "SSH key",
    openwrt: "dropbear authorized key",
    explain:
      "The private key on this computer that the app logs in to every device with, as root over SSH. Its public half must already be in each device's authorized keys (LuCI: System › Administration › SSH-Keys); the app does not install it.",
  },
  {
    path: "admin.password",
    label: "Password",
    secret: true,
    openwrt: "root password",
    explain:
      "The devices' root password, used to log in over SSH when there is no key. The app only logs in with it; it never changes the password on the devices.",
  },
  {
    path: "admin.authorized_keys",
    label: "Authorized keys",
    description: "Public keys that may log in to the devices as root.",
    openwrt: "/etc/dropbear/authorized_keys",
    explain:
      "Installed on every device by each apply, replacing what was there. Empty leaves each device's own file alone. This app's key belongs here, so it can still log in once password login is off.",
  },
  {
    path: "admin.password_login",
    label: "Password login",
    description: "Whether root may log in with a password.",
    openwrt: "dropbear PasswordAuth, RootPasswordAuth",
    explain:
      "A device fresh from OpenWrt has no root password and lets root in with any password, so anyone on your network could log in. Off, only the authorized keys can, which closes that on the first apply.",
  },

  { path: "hardware", label: "Hardware" },
  { path: "hardware.*", label: (d) => `“${d?.name || "unnamed"}”` },
  {
    path: "hardware.*.name",
    label: "Name",
    description: "Also its hostname.",
    openwrt: "system hostname",
    explain:
      "Set as the device's hostname, so it shows under this name in LuCI and on your network. Access points are reached by it too, as <name>.<local domain>.",
  },
  {
    path: "hardware.*.role",
    label: "Role",
    description: "A router connects to the internet; an access point broadcasts Wi-Fi.",
  },
  {
    path: "hardware.*.location",
    label: "Location",
    openwrt: "system description",
    explain:
      "Shown as the device's description on LuCI's status page, to tell access points apart.",
  },
  { path: "hardware.*.wifi", label: "Wi-Fi" },
  {
    path: "hardware.*.wifi.channel.2g",
    label: "2.4 GHz channel",
    openwrt: "wifi-device channel",
    explain:
      "Pins this access point to one channel on the band. Auto picks the clearest channel each time the access point starts; pinning keeps neighbouring access points on different channels.",
  },
  {
    path: "hardware.*.wifi.channel.5g",
    label: "5 GHz channel",
    openwrt: "wifi-device channel",
    explain:
      "Pins this access point to one channel on the band. Auto picks the clearest channel each time the access point starts; pinning keeps neighbouring access points on different channels.",
  },

  { path: "internet", label: "Internet" },
  { path: "internet.connections", label: "Connections" },
  { path: "internet.connections.*", label: (c) => `“${c?.name || "unnamed"}”` },
  { path: "internet.connections.*.name", label: "Name" },
  {
    path: "internet.connections.*.port",
    label: "Port",
    description: "Where the line plugs into the router.",
    openwrt: "wan interface device",
    explain:
      "The router port this line plugs into. Unset, the one the router's maker marked WAN. A port given to a connection leaves the home network's bridge, so plug nothing else into it.",
  },
  {
    path: "internet.connections.*.connection",
    label: "Connection",
    description: "How the router reaches your provider.",
  },
  {
    path: "internet.connections.*.connection.type",
    label: "Type",
    openwrt: "wan interface proto",
    explain:
      "How the router gets its internet address: by DHCP from a modem or fibre box, by PPPoE with a username and password (common on fibre and DSL), or as a fixed address your provider gave you.",
  },
  { path: "internet.connections.*.connection.username", label: "Username" },
  { path: "internet.connections.*.connection.password", label: "Password", secret: true },
  { path: "internet.connections.*.connection.address", label: "IP address" },
  { path: "internet.connections.*.connection.prefix_length", label: "Subnet mask" },
  { path: "internet.connections.*.connection.gateway", label: "Gateway" },
  { path: "internet.connections.*.connection.dns", label: "DNS servers" },
  {
    path: "internet.connections.*.vlan",
    label: "VLAN tag",
    description: "Some providers need the line tagged with a VLAN.",
  },
  {
    path: "internet.connections.*.ipv6",
    label: "IPv6",
    openwrt: "wan6 interface (DHCPv6)",
    explain:
      "Asks your provider for IPv6 over DHCPv6, and passes a part of the prefix it gets to every network with IPv6 on. Off, every network is IPv4 only. Only the first connection's: two providers' prefixes at once would leave devices using a dead one when a line fails.",
  },
  {
    path: "internet.connections.*.ipv6_prefix",
    label: "IPv6 prefix size",
    description: "How much address space to ask your provider for; each network with IPv6 needs a /64.",
    openwrt: "wan6 reqprefix",
    explain:
      "The size of IPv6 prefix to ask your provider for. Auto takes whatever it offers; set a size if your provider needs to be asked, e.g. /56. Each network with IPv6 takes one /64 of it.",
  },
  {
    path: "internet.connections.*.speed",
    label: "Smart queueing",
    description:
      "Shapes traffic to this line's speed, so calls and games stay smooth under load.",
    openwrt: "SQM · cake, piece_of_cake",
    explain:
      "Shapes traffic to just under this line's speed with cake, so queues build up on the router, where they are kept short, instead of in the modem. Calls and games stay smooth while something big uploads or downloads, and bandwidth is shared fairly between devices. Each line has its own.",
  },
  { path: "internet.connections.*.speed.down_mbps", label: "Download", unit: "Mbit/s" },
  { path: "internet.connections.*.speed.up_mbps", label: "Upload", unit: "Mbit/s" },
  {
    path: "internet.connections.*.speed.line",
    label: "Line type",
    description: "Sets how much each packet really costs on the line.",
  },
  {
    path: "internet.connections.*.weight",
    label: "Share",
    description: "Its share of new connections, against the others'.",
    openwrt: "mwan3 member weight",
    explain:
      "When connections share traffic, each new connection from a device goes out one line or another in proportion to these numbers: 3 against 1 sends three in four out of this one. A single download stays on one line.",
  },
  {
    path: "internet.connections.*.metered",
    label: "Metered",
    description: "Paid by the amount, like mobile data: a backup only, checked sparingly.",
    openwrt: "mwan3 interface interval, track_ip",
    explain: () =>
      `Checks this line with ${meteredCheck.ips.length} address every ${meteredCheck.intervalS} seconds instead of ${lineCheck.ips.length} every ${lineCheck.intervalS}: about ${monthlyMegabytes(meteredCheck)} MB a month of checks rather than ${monthlyMegabytes(lineCheck)} MB, so noticing it fail takes about ${meteredCheck.intervalS * meteredCheck.missesDown} seconds. When connections share traffic, it is never shared: it only carries traffic when the others are down.`,
  },
  {
    path: "internet.connections.*.down_when_slow",
    label: "Down when slow",
    description: "A line that is up but too slow to use counts as down.",
    openwrt: "mwan3 check_quality",
    explain: () =>
      `Each check sends ${slowLine.count} pings to each address and measures them: worse than ${slowLine.failMs} ms or ${slowLine.failLossPct}% lost marks the line down, as if it had failed, until it is better than ${slowLine.recoverMs} ms and ${slowLine.recoverLossPct}% again. For a mobile line that is technically up but unusable.`,
  },
  {
    path: "internet.share_per_device",
    label: "Keep each device on one line",
    description: "Games and calls never switch line mid-way.",
    openwrt: "mwan3 rule sticky",
    explain: () =>
      `Sharing traffic, each new connection goes out one line or another, and only secure websites keep to one. With this on, a device keeps to the line it was given for everything, until it has been quiet for ${stickySeconds / 60} minutes: steadier for games and calls, but one device cannot use both lines at once.`,
  },
  {
    path: "internet.mode",
    label: "Using several",
    description: "How the connections work together.",
    openwrt: "mwan3",
    explain: (intent) =>
      `Failover: everything goes out the first connection that works, in the order listed, and moves to the next within about ${lineCheck.intervalS * lineCheck.missesDown} seconds of a line failing (mwan3 pings ${lineCheck.ips.slice(0, -1).join(", ")} and ${lineCheck.ips[lineCheck.ips.length - 1]} every ${lineCheck.intervalS} seconds out of each line; ${lineCheck.missesDown} misses in a row mark it down). Share: new connections are spread over the working lines by their share, and secure websites keep to one line per device. Either way IPv6 uses the first connection.` +
      (intent.internet.connections.length < 2 ? " Add a second connection to use it." : ""),
  },
  {
    path: "internet.upnp",
    label: "UPnP and NAT-PMP",
    description: "Games and apps on the main network open ports for themselves.",
    openwrt: "miniupnpd",
    explain:
      "Lets devices on the main network open ports on the router for themselves (game consoles, some apps), over UPnP IGD and NAT-PMP. Secure mode is on: a device can only open ports to itself.",
  },

  { path: "networks", label: "Networks" },
  { path: "networks.*", label: (n) => `“${n?.name || "unnamed"}”` },
  { path: "networks.*.name", label: "Name" },
  {
    path: "networks.*.line",
    label: "Internet line",
    description: "Which of your internet connections its devices use.",
    openwrt: "mwan3 policy and rule",
    explain:
      "Unset, its devices go out as the internet's setting says (failover or sharing). Set, they go out the connection chosen, and either use the others when it is down or have no internet until it is back. The router itself, and other networks, are not affected. IPv4 only: IPv6 always uses the first connection.",
  },
  { path: "networks.*.line.connection", label: "Line" },
  { path: "networks.*.line.fallback", label: "Use the others when it is down" },
  {
    path: "networks.*.vlan",
    label: "VLAN",
    description: "Switches between your devices must carry it.",
    openwrt: "bridge-vlan",
    explain:
      "The VLAN ID this network uses. The router and access points tag it on their ports for you; a managed switch between them must carry the same VLAN, tagged.",
  },
  {
    path: "networks.*.subnet",
    label: "Addresses",
    description: "Every device on it gets a new address; the router takes the first.",
  },
  {
    path: "networks.*.dhcp.size",
    label: "Addresses for devices",
    openwrt: "dhcp start / limit",
    explain:
      "How many addresses DHCP hands out, counted down from .254. The rest, from .2 up, stay free for devices you give a fixed address yourself.",
  },
  {
    path: "networks.*.dhcp.lease",
    label: "Lease time",
    openwrt: "dhcp leasetime",
    explain:
      "How long a device keeps its address before renewing it. Shorter frees addresses sooner on a busy guest network; longer means fewer renewals.",
  },
  {
    path: "networks.*.dhcp.dns_servers",
    label: "DNS servers handed out",
    description: "Devices ask these instead of the router.",
    openwrt: "dhcp_option 6",
    explain:
      "Tells devices to ask these DNS servers instead of the router, e.g. a Pi-hole. They then bypass the router's encrypted DNS and its local names.",
  },
  {
    path: "networks.*.ipv6",
    label: "IPv6",
    openwrt: "ip6assign 64 · odhcpd",
    explain:
      "Gives this network one /64 of the internet's IPv6 prefix, announced by router advertisements and DHCPv6 from the router (odhcpd). Devices get public IPv6 addresses, plus a stable private one that never changes.",
  },
  {
    path: "networks.*.reservations",
    label: "Reserved addresses",
    openwrt: "dhcp host (static lease)",
    explain:
      "Devices that always get the same IPv4 address, matched by MAC address, and a name: <name>.<local domain>. Rules and port forwards that point at a device need one.",
  },
  { path: "networks.*.reservations.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "networks.*.reservations.*.name", label: "Name" },
  { path: "networks.*.reservations.*.mac", label: "MAC address" },
  { path: "networks.*.reservations.*.address", label: "Address" },
  {
    path: "networks.*.share_devices",
    label: "Share devices with other networks",
    description: "AirPlay, printers and Chromecasts are seen across the networks that share.",
    openwrt: "avahi reflector",
    explain:
      "Repeats mDNS (Bonjour) between the networks that share, so AirPlay speakers, printers and Chromecasts on one are found from the others. It only makes them visible: reaching them still needs Can reach.",
  },
  { path: "networks.*.access", label: "Access" },
  {
    path: "networks.*.access.internet",
    label: "Internet",
    openwrt: "zone forwarding to wan",
    explain:
      "Whether devices on this network can reach the internet: a firewall forwarding from this network's zone to the wan zone.",
  },
  {
    path: "networks.*.access.networks",
    label: "Can reach",
    description: "Other networks its devices may connect to.",
    openwrt: "zone forwardings",
    explain:
      "The other networks this one may open connections to, one firewall forwarding each. Replies always come back, so a network can answer this one without being given access to it.",
  },
  {
    path: "networks.*.access.router",
    label: "Router access",
    description: "Full: anything on the router. Services: addresses, DNS and time only.",
    openwrt: "zone input",
    explain:
      "Full lets devices reach everything on the router, the admin pages and SSH included. Network services rejects everything but DHCP, DNS, NTP and the IPv6 essentials, which suits guests and IoT.",
  },

  { path: "wifi", label: "Wi-Fi" },
  { path: "wifi.*", label: (w) => `“${w?.ssid || "unnamed"}”` },
  {
    path: "wifi.*.ssid",
    label: "Name",
    description: "Devices will have to join the network again under its new name.",
  },
  {
    path: "wifi.*.password",
    label: "Password",
    secret: true,
    description: "Devices will have to join again with the new password.",
  },
  {
    path: "wifi.*.extra_passwords",
    label: "More passwords",
    secret: true,
    openwrt: "wifi-station keys (multi-PSK)",
    explain:
      "More passwords for the same SSID, each with the same access. Hand one out (to a guest, a smart plug) and remove it later without changing the main one. WPA2 only: WPA3 allows a single password.",
  },
  { path: "wifi.*.enabled", label: "Enabled" },
  {
    path: "wifi.*.security",
    label: "Security",
    description: "WPA3 is stronger; WPA2/WPA3 lets older devices still join.",
    openwrt: "wifi-iface encryption: psk2, sae-mixed, sae",
    explain:
      "WPA2/WPA3 lets newer devices use WPA3 (SAE) while older ones use WPA2. WPA3 only is the most secure but locks out older devices. WPA3 always brings protected management frames.",
  },
  { path: "wifi.*.hidden", label: "Hidden" },
  {
    path: "wifi.*.roaming_assistance",
    label: "Roaming assistance",
    description: "Access points tell devices about their neighbours (802.11k/v).",
    openwrt: "802.11k/v · usteer ssid_list",
    explain: (intent, [i]) => {
      const level = intent.roaming?.steering ?? "advise";
      const base =
        "Access points tell devices about their neighbours (802.11k) and can suggest a better one (802.11v), with usteer sharing what each access point sees.";
      return level !== "off" && intent.wifi?.[Number(i)]?.roaming_assistance === false
        ? `${base} Off for this SSID: no neighbour lists, and steering (${where("roaming")}) leaves its devices alone.`
        : `${base} Steering is ${steeringLabels[level]} (${where("roaming")}): ${describeSteering(level)}`;
    },
  },
  {
    path: "wifi.*.fast_roaming",
    label: "Fast roaming",
    description: "Devices move between access points without a pause (802.11r).",
    openwrt: "802.11r (fast transition)",
    explain:
      "Moving between access points takes milliseconds instead of a full reconnect, so calls do not drop. A few old devices cannot join an SSID with it on; turn it off if one will not connect.",
  },
  { path: "wifi.*.bands", label: "Bands" },
  {
    path: "wifi.*.isolate_clients",
    label: "Isolate clients",
    description: "Whether devices on it, on the same access point and band, are kept from reaching each other.",
    openwrt: "wifi-iface isolate",
    explain:
      "Devices on this SSID cannot reach each other directly on the same access point and band, only the internet and what the network's access allows. Good for guests.",
  },
  { path: "radios", label: "Radios" },
  { path: "roaming", label: "Roaming" },
  {
    path: "roaming.steering",
    label: "Steering",
    description: "How firmly access points move devices to a better access point or band.",
    openwrt: "usteer roam_trigger_snr, aggressiveness, min_snr",
    explain: describeSteeringLevels,
  },
  {
    path: "roaming.prefer_5g",
    label: "Prefer 5 GHz",
    description: "Moves dual-band devices with a strong signal off 2.4 GHz.",
    openwrt: "usteer band steering",
    explain: (intent) => describePrefer5g(intent.roaming?.steering ?? "advise"),
  },

  { path: "radios.5g", label: "5 GHz" },
  { path: "radios.6g", label: "6 GHz" },
  { path: "radios.*.enabled", label: "Enabled" },
  {
    path: "radios.*.width",
    label: "Channel width",
    openwrt: "wifi-device htmode (HE20 to HE160)",
    explain:
      "Wider channels are faster, but there are fewer of them, so they overlap neighbours more. Auto is 20 MHz on 2.4 GHz, 80 MHz on 5 GHz and 160 MHz on 6 GHz, at Wi-Fi 6 rates.",
  },
  {
    path: "radios.*.power",
    label: "Transmit power",
    openwrt: "wifi-device txpower",
    explain:
      "Auto transmits at the most your country allows. Low, Medium and High are 10, 15 and 20 dBm, still capped by the country's limit.",
  },
  {
    path: "radios.*.cell_density",
    label: "Cell density",
    openwrt: "wifi-device cell_density",
    explain:
      "Raises the slowest data rate devices may use, so slow, distant devices cannot hold the air for long. Normal, High and Very high are OpenWrt's levels 1 to 3; Off allows the slowest legacy rates.",
  },
  {
    path: "radios.*.airtime",
    label: "Airtime",
    description: "What the band's Wi-Fi queues favour: latency, balance or throughput.",
    openwrt: "AQL, aql_txq_limit",
    explain:
      "How much each radio queues per device, in airtime. Low latency queues little (2–4 ms), keeping calls responsive while someone downloads; Throughput queues more (8–20 ms) to keep the air full; Balanced is the kernel's 5–12 ms.",
  },
  {
    path: "wifi.*.network",
    label: "Network",
    description: "Devices joining this Wi-Fi land on that network.",
  },

  { path: "firewall", label: "Firewall" },
  {
    path: "firewall.rules",
    label: "Rules",
    openwrt: "firewall rules",
    explain:
      "Exceptions to what each network's access allows, checked in order, between your networks, the internet and the router.",
  },
  { path: "firewall.rules.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "firewall.rules.*.name", label: "Name" },
  { path: "firewall.rules.*.enabled", label: "Enabled" },
  { path: "firewall.rules.*.from", label: "From" },
  { path: "firewall.rules.*.to", label: "To" },
  { path: "firewall.rules.*.source_addresses", label: "Only from" },
  { path: "firewall.rules.*.destination_addresses", label: "Only to" },
  { path: "firewall.rules.*.protocol", label: "Protocol" },
  { path: "firewall.rules.*.destination_port", label: "Ports" },
  {
    path: "firewall.rules.*.action",
    label: "Action",
    openwrt: "rule target: ACCEPT, DROP, REJECT",
    explain:
      "Allow or block. A block from the internet drops traffic silently; from your own networks it refuses it, so devices give up at once instead of waiting.",
  },
  {
    path: "firewall.port_forwards",
    label: "Port forwarding",
    openwrt: "firewall redirect (DNAT)",
    explain:
      "Opens a port on your internet address and passes what arrives to a device inside.",
  },
  { path: "firewall.port_forwards.*", label: (p) => `“${p?.name || "unnamed"}”` },
  { path: "firewall.port_forwards.*.name", label: "Name" },
  { path: "firewall.port_forwards.*.enabled", label: "Enabled" },
  { path: "firewall.port_forwards.*.protocol", label: "Protocol" },
  { path: "firewall.port_forwards.*.external_port", label: "External port" },
  { path: "firewall.port_forwards.*.internal_address", label: "Internal address" },
  { path: "firewall.port_forwards.*.internal_port", label: "Internal port" },
  { path: "firewall.port_forwards.*.source_addresses", label: "Only from" },
  {
    path: "firewall.port_forwards.*.reflection",
    label: "NAT loopback",
    openwrt: "redirect reflection",
    explain:
      "Lets devices at home reach the forward at your internet address too, so the same address works at home and away.",
  },

  { path: "dns", label: "DNS" },
  {
    path: "dns.local_domain",
    label: "Local domain",
    description: "Devices are reachable as name.domain.",
    openwrt: "dnsmasq domain",
    explain:
      "The suffix for local names: devices and reservations are found as <name>.<domain>, and lookups for it never leave the router.",
  },
  {
    path: "dns.upstream",
    label: "DNS servers",
    description: "Where the router looks names up.",
    openwrt: "dnsmasq servers · https-dns-proxy",
    explain:
      "Where the router looks names up. Encrypted sends lookups over HTTPS (DoH) to the provider, so your internet provider cannot read or alter them: dnsmasq forwards to https-dns-proxy on the router.",
  },
  { path: "dns.upstream.type", label: "Type" },
  { path: "dns.upstream.provider", label: "Encrypted DNS provider" },
  { path: "dns.upstream.servers", label: "Servers" },
  {
    path: "dns.rebind_protection",
    label: "Rebind protection",
    description: "Answers from the internet may not point at your own addresses.",
    openwrt: "dnsmasq rebind_protection",
    explain:
      "Refuses answers from the internet that point at private addresses, which blocks DNS rebinding attacks on devices at home. Turn it off if a service you use resolves to a local address on purpose.",
  },
  {
    path: "dns.records",
    label: "Local names",
    openwrt: "dnsmasq domain (hostname)",
    explain:
      "Your own names: <name>.<local domain> answers with the address you give, on every network.",
  },
  { path: "dns.records.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "dns.records.*.name", label: "Name" },
  { path: "dns.records.*.address", label: "Address" },
];

const matches = (pattern: string, path: string[]) => {
  const parts = pattern.split(".");
  return (
    parts.length === path.length &&
    parts.every((part, i) => part === "*" || part === path[i])
  );
};

export const fieldInfo = (path: string[]) =>
  fields.find((field) => matches(field.path, path));

/** A setting's explainer, given the rest of the intent. */
export const explainFor = (path: string[], intent: Intent) => {
  const info = fieldInfo(path);
  if (typeof info?.explain !== "function") return info?.explain;
  const at = info.path.split(".").flatMap((part, i) => (part === "*" ? [path[i]] : []));
  return info.explain(intent, at);
};
