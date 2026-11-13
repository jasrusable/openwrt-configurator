import { internetIpv6, ipv6Interface, networkHasIpv6, primaryConnection } from "../connections";
import { deviceOf } from "../networks";
import { Patch } from "./patch";

const watchScript = "/usr/libexec/onc/odhcpd-watch";
const watchService = "onc-odhcpd-watch";

/**
 * Restarts odhcpd while a network with a link has no odhcpd advertising on
 * it. odhcpd joins all-routers (ff02::2) on each network it advertises on,
 * besides the kernel's own join where forwarding is on, so its users count
 * says (verified on 25.12.6: br-lan.1 2, the bare ports 1). Checked twice,
 * 5 s apart, and at most one restart a minute (each loses DHCPv6 leases,
 * odhcpd#400). `once` checks once, for tests.
 */
export const watcher = (devices: string[]) => `#!/bin/sh
devices="${devices.join(" ")}"
carrier() { [ "$(cat "/sys/class/net/$1/carrier" 2>/dev/null)" = 1 ]; }
serving() {
	users=$(awk -v d="$1" '$2 == d && $3 == "ff020000000000000000000000000002" { print $4 }' /proc/net/igmp6)
	kernel=$(cat "/proc/sys/net/ipv6/conf/$1/forwarding" 2>/dev/null)
	[ "\${users:-0}" -gt "\${kernel:-0}" ]
}
silent() { carrier "$1" && ! serving "$1"; }
check() {
	pidof odhcpd >/dev/null 2>&1 || return 1
	for d in $devices; do
		silent "$d" || continue
		sleep 5
		silent "$d" || continue
		logger -t onc-ipv6 "odhcpd is not advertising on $d: restarting it"
		/etc/init.d/odhcpd restart
		return 0
	done
	return 1
}
[ "$1" = once ] && { check; exit 0; }
sleep 60
while :; do
	check && sleep 60
	sleep 30
done
`;

export const odhcpdRaRestart: Patch = {
  id: "odhcpd-ra-restart",
  title: "odhcpd restarted when IPv6 advertisements stall",
  required: true,
  note: "odhcpd is restarted when wan6 gets its route, and when it stops advertising on a network, so devices keep getting IPv6",
  affects: ["internet.lines.*.ipv6.enabled"],
  why:
    "odhcpd starts before wan6 has an IPv6 default route, advertises a lifetime of 0 and " +
    "never recovers, so every client is left link-local only; restarting it once the " +
    "route exists fixes it (seen on 25.12.5, odhcpd 2026.06.29). Its reload also keeps the " +
    "device a network had: an apply that moved the LAN (br-lan to br-lan.1) left it sending " +
    "to one that was gone, the same silence. And it drops a network whose link is down when it " +
    "starts or reloads, and never takes it up again once the link returns (a cable plugged in " +
    "late, an access point restarting during an apply). So a watcher restarts it whenever a " +
    "network with a link has no odhcpd advertising on it, whatever the cause.",
  kind: "fix",
  references: [
    { kind: "issue", url: "https://github.com/openwrt/odhcpd/issues/388", note: "open: RA not sent on LAN when the log level is below 7 (odhcpd 2026.01.19), the same silence" },
    { kind: "issue", url: "https://github.com/openwrt/odhcpd/issues/423", note: "the user's report: carrier loss withdraws every advertised prefix" },
    { kind: "issue", url: "https://github.com/openwrt/odhcpd/issues/400", note: "open: the cost of each restart, DHCPv6 leases are lost (managed-config clients renumber)" },
    { kind: "pr", url: "https://github.com/openwrt/odhcpd/pull/364", note: "open, WIP: leases kept across restarts, which would make the restarts free" },
    { kind: "commit", url: "https://github.com/openwrt/odhcpd/commit/fad2c8b4", note: "config: keep a link-down interface over a reload (2026-10-28), after 25.12's odhcpd (2026-06-29)" },
    { kind: "issue", url: "https://github.com/openwrt/openwrt/issues/25366", note: "open: no RAs on bridges whose link was down when odhcpd started" },
    { kind: "report", url: "https://github.com/openwrt/odhcpd/issues/423", note: "seen twice on the user's router (25.12.5, odhcpd 2026.06.29)" },
  ],
  added: "2026-10-11",
  verified: "the user's NanoPi R6S on 25.12.5: clients link-local only until odhcpd was restarted",
  dropWhen: "odhcpd recovers on its own once wan6 has a default route, follows a network moved to another device, and keeps a link-down network over a reload (fad2c8b4)",
  target: { roles: ["router"] },
  // Only the internet's IPv6 brings up wan6 and router advertisements.
  applies: (intent) => internetIpv6(intent),
  // The main connection's IPv6 interface: wan6, or wanb6 when that line is the main one.
  apply: (intent) => ({
    services: [{ name: watchService, running: true }],
    files: [
      {
        path: watchScript,
        mode: "0755",
        content: watcher(intent.networks.filter((n) => networkHasIpv6(intent, n)).map(deviceOf)),
      },
      {
        path: `/etc/init.d/${watchService}`,
        mode: "0755",
        content: `#!/bin/sh /etc/rc.common
# The odhcpd watcher (${watchScript}), kept running by procd.
START=99
USE_PROCD=1

start_service() {
	procd_open_instance
	procd_set_param command ${watchScript}
	procd_set_param respawn
	procd_close_instance
}
`,
      },
      {
        path: "/etc/hotplug.d/iface/30-odhcpd-ra-fix",
        mode: "0755",
        content: `#!/bin/sh
# Restart odhcpd once wan6 actually has an IPv6 default route.
#
# odhcpd starts before WAN DHCPv6 finishes, so its default-route test fails
# and it advertises ra_lifetime 0. NETEV_ROUTE6_ADD is supposed to recover
# it; on this hardware it does not. A restart after the route exists does.
#
# wan6 also flaps ~11s after the first ifup. The post-flap ifup is the one
# that must restart odhcpd \u2014 a cooldown that ignores it leaves every client
# link-local only. Concurrent overlapping runs are serialised with mkdir.
[ "$ACTION" = "ifup" ] || exit 0

[ "$INTERFACE" = "${ipv6Interface(primaryConnection(intent))}" ] || exit 0

(
	LOCK=/tmp/onc-ipv6-ra.lock
	mkdir "$LOCK" 2>/dev/null || exit 0
	trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

	i=0
	while [ $i -lt 15 ]; do
		ip -6 route show default 2>/dev/null | grep -q . && break
		sleep 1
		i=$((i + 1))
	done

	if ! ip -6 route show default 2>/dev/null | grep -q .; then
		logger -t onc-ipv6 "wan6 up but no IPv6 default route after 15s; leaving odhcpd alone"
		exit 0
	fi

	pidof odhcpd >/dev/null 2>&1 || exit 0

	logger -t onc-ipv6 "wan6 has an IPv6 default route, restarting odhcpd so it advertises the delegated prefix"
	/etc/init.d/odhcpd restart
) >/dev/null 2>&1 &
`,
      },
    ],
  }),
};
