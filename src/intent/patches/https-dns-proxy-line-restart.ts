import { ipv6Interface } from "../connections";
import { Patch } from "./patch";

export const httpsDnsProxyLineRestart: Patch = {
  id: "https-dns-proxy-line-restart",
  title: "https-dns-proxy restarted when an internet line comes up",
  required: true,
  note: "https-dns-proxy is started again when a line comes up, so DNS follows the internet back",
  affects: ["dns.upstream"],
  why:
    "https-dns-proxy started before the line had an address kept failing after it had one: on the user's " +
    "router DNS stayed dead for ~70 s after the WAN came up (dnsmasq's 150 forwarded queries full, its " +
    "own proxies never answering), until it recovered on its own. The package means to follow the line " +
    "(an interface trigger), but that trigger and even its restart are a reload, and procd keeps an " +
    "instance whose command line is unchanged: the processes were the ones started at boot. A stop and " +
    "a start makes them resolve the provider and connect anew.",
  kind: "fix",
  references: [
    {
      kind: "docs",
      url: "https://github.com/openwrt/packages/blob/master/net/https-dns-proxy/files/etc/init.d/https-dns-proxy",
      note: "restart() is reload(); the interface trigger runs reload: neither replaces running instances",
    },
    {
      kind: "docs",
      url: "https://github.com/aarond10/https_dns_proxy/blob/master/src/dns_poller.c",
      note: "a failed lookup of the provider is retried every 5 s: on paper it recovers by itself, yet it took ~70 s",
    },
  ],
  added: "2026-10-23",
  verified:
    "the user's NanoPi R6S on 25.12.6 (https-dns-proxy 2026.05.06), 2026-10-23: proxies started 50 s before the WAN, " +
    "their pids unchanged after its ifup and the package's reload, DNS dead ~70 s after it came up",
  dropWhen: "https-dns-proxy recovers by itself once a line comes up, or its interface trigger replaces the instances",
  target: { roles: ["router"] },
  applies: (intent) => intent.dns.upstream.type === "encrypted",
  apply: (intent) => ({
    files: [
      {
        path: "/etc/hotplug.d/iface/40-onc-doh-restart",
        mode: "0755",
        content: `#!/bin/sh
# Restart https-dns-proxy when an internet line comes up.
#
# Started before the line had an address, the proxies kept failing after it
# had one: DNS stayed dead ~70s after the WAN came up. The package's own
# interface trigger reloads, and procd keeps an instance whose command line
# is unchanged, so only a stop and a start makes them resolve the provider
# and connect anew. Stopping leaves dnsmasq alone: this app manages
# dnsmasq's servers itself (dnsmasq_config_update '-').
[ "$ACTION" = "ifup" ] || exit 0
case " ${intent.internet.lines.flatMap((line) => [line.id, ...(line.ipv6.enabled ? [ipv6Interface(line)] : [])]).join(" ")} " in
	*" $INTERFACE "*) ;;
	*) exit 0 ;;
esac

(
	# A line and its IPv6 come up together: one restart for both.
	LOCK=/tmp/onc-doh-restart.lock
	mkdir "$LOCK" 2>/dev/null || exit 0
	trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
	sleep 3
	/etc/init.d/https-dns-proxy enabled || exit 0
	logger -t onc-dns "$INTERFACE came up: restarting https-dns-proxy so it connects anew"
	/etc/init.d/https-dns-proxy stop
	/etc/init.d/https-dns-proxy start
) >/dev/null 2>&1 &
`,
      },
    ],
  }),
};
