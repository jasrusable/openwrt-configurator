// What each internet setting is called and does, for people (fields.ts): its
// numbers come from where the compiler takes them (connections.ts, compile.ts).
import type { FieldInfo } from "../feature";
import { lineCheck, meteredCheck, monthlyMegabytes, secondsToDown, slowLine, stickySeconds } from "../connections";
import { ddnsCheckMinutes } from "./constants";

export const internetFields: FieldInfo[] = [
  { path: "internet", label: "Internet" },
  { path: "internet.lines", label: "Connections" },
  { path: "internet.lines.*", label: (c) => `“${c?.name || "unnamed"}”` },
  { path: "internet.lines.*.name", label: "Name" },
  {
    path: "internet.lines.*.port",
    label: "Port",
    description: "Where the line plugs into the router.",
    openwrt: "wan interface device",
    explain:
      "The router port this line plugs into. Unset, the one the router's maker marked WAN. A port given to a connection leaves the home network's bridge, so plug nothing else into it.",
  },
  {
    path: "internet.lines.*.type",
    label: "Connection",
    description: "How the router reaches your provider.",
    openwrt: "wan interface proto",
    explain:
      "How the router gets its internet address: by DHCP from a modem or fibre box, by PPPoE with a username and password (common on fibre and DSL), or as a fixed address your provider gave you.",
  },
  { path: "internet.lines.*.pppoe", label: "PPPoE" },
  { path: "internet.lines.*.pppoe.username", label: "Username" },
  { path: "internet.lines.*.pppoe.password", label: "Password", secret: true },
  { path: "internet.lines.*.static", label: "Fixed address" },
  { path: "internet.lines.*.static.address", label: "IP address" },
  { path: "internet.lines.*.static.prefix_length", label: "Subnet mask" },
  { path: "internet.lines.*.static.gateway", label: "Gateway" },
  { path: "internet.lines.*.static.dns", label: "DNS servers" },
  {
    path: "internet.lines.*.vlan",
    label: "VLAN tag",
    description: "Some providers need the line tagged with a VLAN.",
  },
  {
    path: "internet.lines.*.ipv6.enabled",
    label: "IPv6",
    openwrt: "wan6 interface (DHCPv6)",
    explain:
      "Asks your provider for IPv6 over DHCPv6, and passes a part of the prefix it gets to every network with IPv6 on. Off, every network is IPv4 only. Only the first connection's: two providers' prefixes at once would leave devices using a dead one when a line fails.",
  },
  {
    path: "internet.lines.*.ipv6.prefix",
    label: "IPv6 prefix size",
    description: "How much address space to ask your provider for; each network with IPv6 needs a /64.",
    openwrt: "wan6 reqprefix",
    explain:
      "The size of IPv6 prefix to ask your provider for. Auto takes whatever it offers; set a size if your provider needs to be asked, e.g. /56. Each network with IPv6 takes one /64 of it.",
  },
  {
    path: "internet.lines.*.shaping",
    label: "Smart queueing",
    description:
      "Shapes traffic to this line's speed, so calls and games stay smooth under load.",
    openwrt: "SQM · cake, piece_of_cake",
    explain:
      "Shapes traffic to just under this line's speed with cake, so queues build up on the router, where they are kept short, instead of in the modem. Calls and games stay smooth while something big uploads or downloads, and bandwidth is shared fairly between devices. Each line has its own.",
  },
  { path: "internet.lines.*.shaping.down_mbps", label: "Download", unit: "Mbit/s" },
  { path: "internet.lines.*.shaping.up_mbps", label: "Upload", unit: "Mbit/s" },
  {
    path: "internet.lines.*.shaping.medium",
    label: "Line type",
    description: "Sets how much each packet really costs on the line.",
  },
  {
    path: "internet.lines.*.failover.weight",
    label: "Share",
    description: "Its share of new connections, against the others'.",
    openwrt: "mwan3 member weight",
    explain:
      "When connections share traffic, each new connection from a device goes out one line or another in proportion to these numbers: 3 against 1 sends three in four out of this one. A single download stays on one line.",
  },
  {
    path: "internet.lines.*.failover.metered",
    label: "Metered",
    description: "Paid by the amount, like mobile data: a backup only, checked sparingly.",
    openwrt: "mwan3 interface interval, track_ip",
    explain: () =>
      `Checks this line with ${meteredCheck.ips.length} address every ${meteredCheck.intervalS} seconds instead of ${lineCheck.ips.length} every ${lineCheck.intervalS}: about ${monthlyMegabytes(meteredCheck)} MB a month of checks rather than ${monthlyMegabytes(lineCheck)} MB, so noticing it fail takes about ${secondsToDown(meteredCheck)} seconds (with "down when slow", each check sends ${slowLine.count} pings, so ${slowLine.count} times the data). It only carries traffic when the others are down: after every other line in failover, never shared when sharing.`,
  },
  {
    path: "internet.lines.*.failover.down_when_slow",
    label: "Down when slow",
    description: "A line that is up but too slow to use counts as down.",
    openwrt: "mwan3 check_quality",
    explain: () =>
      `Each check sends ${slowLine.count} pings to each address and measures them: worse than ${slowLine.failMs} ms or ${slowLine.failLossPct}% lost marks the line down, as if it had failed, until it is better than ${slowLine.recoverMs} ms and ${slowLine.recoverLossPct}% again. For a mobile line that is technically up but unusable.`,
  },
  {
    path: "internet.use_lines.sticky_per_device",
    label: "Keep each device on one line",
    description: "Games and calls never switch line mid-way.",
    openwrt: "mwan3 rule sticky",
    explain: () =>
      `Sharing traffic, each new connection goes out one line or another, and only secure websites keep to one. With this on, a device keeps to the line it was given for everything, until it has been quiet for ${stickySeconds / 60} minutes: steadier for games and calls, but one device cannot use both lines at once.`,
  },
  {
    path: "internet.use_lines.mode",
    label: "Using several",
    description: "How the connections work together.",
    openwrt: "mwan3",
    explain: (intent) =>
      `Failover: everything goes out the first connection that works, in the order listed, and moves to the next within about ${secondsToDown(lineCheck)} seconds of a line failing (mwan3 pings ${lineCheck.ips.slice(0, -1).join(", ")} and ${lineCheck.ips[lineCheck.ips.length - 1]} out of each line, waiting up to ${lineCheck.timeoutS} seconds for each, then ${lineCheck.intervalS} seconds before the next round; ${lineCheck.missesDown} failed rounds in a row mark it down). A metered line comes after all the others. Share: new connections are spread over the working lines by their share, and secure websites keep to one line per device. Either way IPv6 uses the first connection.` +
      (intent.internet.lines.length < 2 ? " Add a second connection to use it." : ""),
  },
  {
    path: "internet.dynamic_dns",
    label: "Name on the internet",
    description: "A name that follows your internet address, for remote access.",
    openwrt: "ddns-scripts",
    explain:
      `Keeps a name (home.example.com) pointing at your internet address as it changes, at your DNS provider, checked every ${ddnsCheckMinutes} minutes. The address is read from the web, so it works behind another router too. Remote access and other sites use the name.`,
  },
  { path: "internet.dynamic_dns.provider", label: "Provider" },
  { path: "internet.dynamic_dns.hostname", label: "Name" },
  { path: "internet.dynamic_dns.token", label: "API token", secret: true },
  {
    path: "internet.dynamic_dns.zone",
    label: "Zone",
    description: "Unset: the name's last two parts.",
    explain: "The Cloudflare zone the name is in: for vpn.home.example.co.uk, example.co.uk. Unset, the last two parts of the name (example.com), which is right unless the domain ends in two parts of its own.",
  },
  {
    path: "internet.upnp",
    label: "UPnP and NAT-PMP",
    description: "Lets games and apps open the ports they need.",
    openwrt: "miniupnpd",
    explain:
      "Lets devices on the main network open ports on the router for themselves (game consoles, some apps), over UPnP IGD and NAT-PMP. Secure mode is on: a device can only open ports to itself.",
  },
];
