import { internetIpv6, ipv6Interface, primaryConnection } from "../connections";
import { Patch } from "./patch";

export const odhcpdRaRestart: Patch = {
  id: "odhcpd-ra-restart",
  title: "odhcpd restarted when IPv6 advertisements stall",
  required: true,
  note: "odhcpd is restarted when wan6 gets its route, and when a network moves, so devices keep getting IPv6",
  affects: ["internet.lines.*.ipv6.enabled"],
  why:
    "odhcpd starts before wan6 has an IPv6 default route, advertises a lifetime of 0 and " +
    "never recovers, so every client is left link-local only; restarting it once the " +
    "route exists fixes it (seen on 25.12.5, odhcpd 2026.06.29). Its reload also keeps the " +
    "device a network had: an apply that moved the LAN (br-lan to br-lan.1) left it sending " +
    "to one that was gone, the same silence; so it is restarted when one of the networks comes up.",
  kind: "fix",
  references: [
    { kind: "issue", url: "https://github.com/openwrt/odhcpd/issues/388", note: "open: RA not sent on LAN when the log level is below 7 (odhcpd 2026.01.19), the same silence" },
    { kind: "issue", url: "https://github.com/openwrt/odhcpd/issues/423", note: "the user's report: carrier loss withdraws every advertised prefix" },
    { kind: "issue", url: "https://github.com/openwrt/odhcpd/issues/400", note: "open: the cost of each restart, DHCPv6 leases are lost (managed-config clients renumber)" },
    { kind: "pr", url: "https://github.com/openwrt/odhcpd/pull/364", note: "open, WIP: leases kept across restarts, which would make the restarts free" },
    { kind: "report", url: "https://github.com/openwrt/odhcpd/issues/423", note: "seen twice on the user's router (25.12.5, odhcpd 2026.06.29)" },
  ],
  added: "2026-10-11",
  verified: "the user's NanoPi R6S on 25.12.5: clients link-local only until odhcpd was restarted",
  dropWhen: "odhcpd recovers on its own once wan6 has a default route, and follows a network moved to another device",
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

# A network of ours coming up (an apply that moved it to another device,
# br-lan to br-lan.1): odhcpd's reload keeps the device it had and goes on
# sending to one that is gone, so the whole network loses IPv6 (seen on a
# real router). Restart it, once for several networks coming up together,
# and only once its device has carrier: restarted while the bridge had
# none, odhcpd dropped the interface and never took it up again (odhcpd#423).
case " ${intent.networks.map((n) => n.id).join(" ")} " in *" $INTERFACE "*)
	(
		LOCK=/tmp/onc-odhcpd-lan.lock
		mkdir "$LOCK" 2>/dev/null || exit 0
		trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
		if [ -n "$DEVICE" ]; then
			carrier() { [ "$(cat "/sys/class/net/$DEVICE/carrier" 2>/dev/null)" = 1 ]; }
			i=0
			while ! carrier && [ $i -lt 15 ]; do sleep 1; i=$((i + 1)); done
			if ! carrier; then
				logger -t onc-ipv6 "$INTERFACE came up without carrier on $DEVICE; leaving odhcpd alone"
				exit 0
			fi
		fi
		sleep 3
		pidof odhcpd >/dev/null 2>&1 || exit 0
		logger -t onc-ipv6 "$INTERFACE came up: restarting odhcpd so it advertises on it"
		/etc/init.d/odhcpd restart
	) >/dev/null 2>&1 &
	exit 0
	;;
esac

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
