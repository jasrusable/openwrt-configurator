// What a device built by this app comes up as when it starts fresh: flashed
// clean, or reset to its defaults. Not OpenWrt's 192.168.1.1 with a DHCP
// server, which on an access point would hand out addresses on the wrong
// subnet beside the router's, but reachable on the main network, ready for
// the next apply: the router on the main network's address with its DHCP
// pool, an access point a DHCP client with every port bridged (whichever one
// is cabled works), the authorized keys installed.
//
// Images are built on ASU, a public server, so nothing here may be secret:
// the script is made from `firstBootOf`'s few fields only (addresses, the
// pool, the time zone, public keys), the same for every device of a role,
// never a hostname, a MAC or a password. It runs on the first boot after a
// flash and after every reset (it lives in the image); after an upgrade that
// kept the settings, the applied marker (agent/paths.ts, kept through
// upgrades by keep.d) is there and it does nothing.
import { mainNetwork, gatewayOf } from "../intent/fragment";
import { poolStart } from "../intent/networks";
import type { Intent } from "../intent/schema";
import { timezones } from "../intent/system";
import { netmask } from "../intent/addresses";
import { appliedMarker } from "../agent/paths";
import { shellQuote } from "../shell";

export type Role = "router" | "access-point";

/** Everything a first boot is made of: nothing else from the settings reaches an image. */
export type FirstBoot = {
  role: Role;
  /** The router's address on the main network, its netmask, and the DHCP pool it serves there. */
  lan?: { address: string; netmask: string; start: number; limit: number };
  /** POSIX TZ and its IANA name. */
  time: { timezone: string; zonename: string };
  /** Public keys; with any, password login is turned off (no password is in the image to log in with). */
  authorizedKeys: string[];
};

export const firstBootOf = (intent: Intent, role: Role): FirstBoot => {
  const main = mainNetwork(intent);
  return {
    role,
    ...(role === "router"
      ? { lan: { address: gatewayOf(main), netmask: netmask(24), start: poolStart(main), limit: main.dhcp.pool_size } }
      : {}),
    time: { timezone: timezones[intent.system.timezone] ?? "UTC0", zonename: intent.system.timezone },
    authorizedKeys: intent.system.ssh.authorized_keys,
  };
};

const set = (option: string, value: string | number) => `uci -q set ${option}=${shellQuote(value)}`;

/** The router: the main network's address and pool; WAN stays OpenWrt's DHCP client. */
const routerLines = (lan: NonNullable<FirstBoot["lan"]>) => [
  set("network.lan.ipaddr", lan.address),
  set("network.lan.netmask", lan.netmask),
  set("dhcp.lan.start", lan.start),
  set("dhcp.lan.limit", lan.limit),
];

/**
 * An access point: a DHCP client of the main network, serving nothing, with
 * the WAN port (config_generate's, from board.json) in the LAN bridge and STP
 * on, so two cables to one switch cannot loop the network.
 */
const accessPointLines = () => [
  "uci -q delete network.lan.ipaddr",
  "uci -q delete network.lan.netmask",
  "uci -q delete network.lan.ip6assign",
  set("network.lan.proto", "dhcp"),
  set("dhcp.lan.ignore", 1),
  set("dhcp.lan.dhcpv6", "disabled"),
  set("dhcp.lan.ra", "disabled"),
  `br=$(uci -q show network | sed -n "s/^network\\.\\([^.]*\\)\\.name='br-lan'$/\\1/p" | head -n 1)`,
  `wan=$(uci -q get network.wan.device)`,
  `if [ -n "$br" ]; then`,
  `\t[ -n "$wan" ] && uci -q add_list "network.$br.ports=$wan"`,
  `\tuci -q set "network.$br.stp=1"`,
  `fi`,
  "uci -q delete network.wan",
  "uci -q delete network.wan6",
];

const keyLines = (keys: string[]) =>
  keys.length === 0
    ? []
    : [
        "mkdir -p /etc/dropbear",
        `printf '%s\\n' ${keys.map(shellQuote).join(" ")} > /etc/dropbear/authorized_keys`,
        "chmod 600 /etc/dropbear/authorized_keys",
        set("dropbear.@dropbear[0].PasswordAuth", "off"),
        set("dropbear.@dropbear[0].RootPasswordAuth", "off"),
      ];

/** ASU refuses a defaults script over this. */
export const firstBootMaxBytes = 20480;

/** The uci-defaults script: plain POSIX sh, busybox-safe. */
export const firstBootScript = (boot: FirstBoot) =>
  [
    "#!/bin/sh",
    "# openwrt-configurator: how this device comes up fresh (flashed clean, or reset):",
    "# reachable on its network for the next apply. Nothing secret is in it.",
    `# An upgrade that kept the settings left the applied marker: those stand.`,
    `[ -f ${appliedMarker} ] && exit 0`,
    ...(boot.lan ? routerLines(boot.lan) : accessPointLines()),
    set("system.@system[0].timezone", boot.time.timezone),
    set("system.@system[0].zonename", boot.time.zonename),
    ...keyLines(boot.authorizedKeys),
    "uci commit",
    "exit 0",
    "",
  ].join("\n");
