import { internetIpv6, ipv6Interface, primaryConnection } from "../connections";
import { Patch } from "./patch";

export const odhcpdRaRestart: Patch = {
  id: "odhcpd-ra-restart",
  why:
    "odhcpd starts before wan6 has an IPv6 default route, advertises a lifetime of 0 and " +
    "never recovers, so every client is left link-local only; restarting it once the " +
    "route exists fixes it (seen on 25.12.5, odhcpd 2026.06.29).",
  upstream: "https://github.com/openwrt/odhcpd/issues/388",
  target: { roles: ["router"] },
  // Only the internet's IPv6 brings up wan6 and router advertisements.
  applies: (intent) => internetIpv6(intent),
  // The main connection's IPv6 interface: wan6, or wanb6 when that line is the main one.
  apply: (intent) => ({
    files: [
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
