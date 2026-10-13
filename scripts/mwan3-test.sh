#!/bin/sh
# mwan3 on a real OpenWrt userland: a router container with two internet
# lines (a Docker network each), configured as the app compiles a two-line
# intent (scripts/mwan3-test-config.ts: mwan3, the lines' interfaces and the
# IPv6-follows-the-line hook). Then the main line's pings are dropped:
#   - mwan3track must log the line offline, in the words Activity reads
#     (src/status/views.ts), and send `disconnected` to the hotplug scripts;
#   - the hook must take the main line's IPv6 interface (wan6) down;
# and let through again: online, `connected`, wan6 brought back up.
# With RECORD=1 the router's mwan3 and hook log lines are saved as a fixture
# (src/tests/helpers/status/mwan3-failover.txt) for mwan3Log.test.ts.
#
# Docker networks run no DHCP server, so each line gets Docker's address
# statically; mwan3 tracks a line by its pings either way.
#
# Needs docker (privileged containers) and `npm ci` done.
# Usage: [ONC_RIG_VERSION=...] [RECORD=1] scripts/mwan3-test.sh

# Router-side snippets are single-quoted on purpose: they expand in the container.
# shellcheck disable=SC2016
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/scripts/openwrt-image.sh"
echo "OpenWrt $version ($image)"
prefix=onc-mwan3-$$
router=$prefix-router
work=$(mktemp -d)
failures=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }

cleanup() {
  docker rm -f "$router" >/dev/null 2>&1 || true
  docker network rm "$prefix-a" "$prefix-b" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

on_router() { docker exec "$router" sh -c "$1"; }
# Wait up to $2 seconds for a router-side condition.
wait_for() { on_router "n=0; until { $1; } >/dev/null 2>&1 || [ \$n -ge $2 ]; do sleep 1; n=\$((n+1)); done; { $1; } >/dev/null 2>&1"; }
address_on() { docker inspect "$router" --format "{{(index .NetworkSettings.Networks \"$1\").IPAddress}}"; }
gateway_on() { docker inspect "$router" --format "{{(index .NetworkSettings.Networks \"$1\").Gateway}}"; }

echo "compiling a two-line intent"
(cd "$root" && npx ts-node --transpile-only scripts/mwan3-test-config.ts) >"$work/config.sh"

# mwan3 and its dependencies, fetched by a container that is not booted (it
# has Docker's route out; a booted one's LAN takes eth0) and installed offline.
echo "fetching mwan3"
mkdir -p "$work/apk"
docker run --rm ${platform:+--platform "$platform"} -v "$work/apk:/out" "$image" \
  sh -c 'mkdir -p /var/lock; apk update >/dev/null 2>&1; apk fetch -R mwan3 -o /out >/dev/null 2>&1' >/dev/null 2>&1
ls "$work/apk"/mwan3-*.apk >/dev/null

echo "booting the router"
docker network create "$prefix-a" >/dev/null
docker network create "$prefix-b" >/dev/null
docker run -d ${platform:+--platform "$platform"} --name "$router" --privileged "$image" /sbin/init >/dev/null 2>&1
# eth1 the main line, eth2 the backup.
docker network connect "$prefix-a" "$router"
docker network connect "$prefix-b" "$router"
wait_for '[ -s /etc/board.json ] && ip link show eth2' 90
quiet_kmsg "$router"
docker cp "$work/apk" "$router:/root/apk" >/dev/null
on_router 'apk add --allow-untrusted --repositories-file /dev/null /root/apk/*.apk >/dev/null 2>&1; [ -x /usr/sbin/mwan3 ]'

docker cp "$work/config.sh" "$router:/root/config.sh" >/dev/null
on_router 'sh /root/config.sh'
for line in wan:"$prefix-a" wanb:"$prefix-b"; do
  name=${line%%:*} net=${line#*:}
  on_router "uci set network.$name.proto=static; uci set network.$name.ipaddr=$(address_on "$net"); uci set network.$name.netmask=255.255.0.0; uci set network.$name.gateway=$(gateway_on "$net"); uci commit network"
done
on_router 'reload_config; /etc/init.d/mwan3 enable; /etc/init.d/mwan3 restart >/dev/null 2>&1'

echo "== mwan3 on two lines"
if wait_for 'ubus call mwan3 status | jsonfilter -e "@.interfaces.wan.status" | grep -qx online && ubus call mwan3 status | jsonfilter -e "@.interfaces.wanb.status" | grep -qx online' 90; then
  pass "both lines tracked online"
else
  fail "both lines tracked online"; on_router 'ubus call mwan3 status' || true
fi

# The main line's pings dropped, nothing else.
on_router 'nft add table inet onc_test; nft add chain inet onc_test out "{ type filter hook output priority 0; }"; nft add rule inet onc_test out oifname eth1 icmp type echo-request drop'
if wait_for 'logread | grep -E "mwan3track.*[Ii]nterface wan .*offline"' 90; then
  pass "mwan3track logs the main line offline"
else
  fail "mwan3track logs the main line offline"; on_router 'logread | grep -i mwan3 | tail -5' || true
fi
if wait_for 'logread | grep -q "onc-ipv6: wan is offline"' 30 && wait_for '[ "$(ubus call network.interface.wan6 status | jsonfilter -e @.autostart)" = false ]' 15; then
  pass "disconnected: the hook takes wan6 down"
else
  fail "disconnected: the hook takes wan6 down"; on_router 'ubus call network.interface.wan6 status | jsonfilter -e @.up -e @.autostart -e @.pending' || true
fi

on_router 'nft delete table inet onc_test'
if wait_for 'logread | grep -E "mwan3track.*[Ii]nterface wan .*online"' 90; then
  pass "mwan3track logs the main line online again"
else
  fail "mwan3track logs the main line online again"
fi
if wait_for '[ "$(ubus call network.interface.wan6 status | jsonfilter -e @.autostart)" = true ]' 30; then
  pass "connected: the hook brings wan6 back"
else
  fail "connected: the hook brings wan6 back"
fi

if [ "${RECORD:-}" = 1 ]; then
  on_router 'logread | grep -E "mwan3track|onc-ipv6"' >"$root/src/tests/helpers/status/mwan3-failover.txt"
  echo "recorded src/tests/helpers/status/mwan3-failover.txt"
fi

echo "== result"
if [ "$failures" -eq 0 ]; then echo "  all passed"; else echo "  $failures failed"; exit 1; fi
