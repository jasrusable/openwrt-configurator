#!/bin/sh
# End-to-end provisioning test against a real OpenWrt userland, no hardware.
#
# Each client gets its own device — openwrt/rootfs booted under procd — and
# its own controller container, and the clients run in parallel:
#   dbclient  QuickJS + dropbear's dbclient, password auth (the on-router path)
#   openssh   QuickJS + OpenSSH, key auth (the Homebrew path)
#   node      Node + ssh2, key auth (the npm/pkg path)
# Checked: host-key trust on first use, a confirmed provision, self-rollback
# when the new config cuts SSH off (by moving dropbear, and by the declarative
# reset deleting it), stray staged changes being discarded while LuCI's are
# kept, the result being exactly the declared config even where a package
# installed mid-run ships its own, and refusal of a changed host key. The router path gets every
# scenario; the others the ones where their SSH client behaves differently.
# The network job provisions two devices as one change: both confirm, or a
# lockout on one rolls back both.
#
# Uses native arm64 images on Apple Silicon and x86-64 elsewhere, and a 15 s
# confirm window (ONC_TEST_MIN_CONFIRM_WINDOW) so rollbacks do not wait out
# the real 90 s default.
#
# Needs docker (privileged containers), jq, openssl and `npm ci` done.
# Usage: scripts/rig-test.sh [job ...]   (default: dbclient openssh node network)

# Device-side snippets are single-quoted on purpose: they expand in the container.
# shellcheck disable=SC2016
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
# The controller's Node, exactly the repo's.
node_image="node:$(cat "$root/.node-version")-alpine"
case "$(uname -m)" in
  # The arm64 rootfs is labelled linux/aarch64_generic, which no --platform
  # matches, so it runs with none; the node image is a normal multi-arch one.
  arm64 | aarch64) image=openwrt/rootfs:armsr-armv8-v25.12.5 platform='' node_platform=linux/arm64 ;;
  *) image=openwrt/rootfs:x86-64-v25.12.5 platform=linux/amd64 node_platform=linux/amd64 ;;
esac
work=$(mktemp -d)
prefix=onc-rig-$$
clients=${*:-dbclient openssh node network}

cleanup() {
  for c in $(docker ps -aq --filter "name=^$prefix-"); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

# --- shared setup ------------------------------------------------------------

echo "building bundles"
(cd "$root" && node scripts/bundle.js && cp dist/qjs/openwrt-configurator.mjs "$work/onc.mjs")
(cd "$root" && npx esbuild bin/index.ts --bundle --platform=node --format=cjs \
  --main-fields=module,main --external:node-ssh --outfile="$work/onc.cjs" --log-level=error)
password=$(openssl rand -hex 12)
# Set through UCI on every provision: it must arrive byte for byte and run nothing.
note='Jason'"'"'s "WiFi" $(touch /tmp/pwned); x'
note_sha=$(printf '%s\n' "$note" | openssl dgst -sha256 | sed 's/.* //')
ssh-keygen -q -t ed25519 -N "" -C onc-rig -f "$work/key"
chmod -R a+rX "$work"
# ...except the private key: OpenSSH refuses one that others can read.
chmod 600 "$work/key"

# A docker run whose noise (pull progress, the arm64 images' nonstandard
# platform label) stays out of the log unless it fails.
run_container() {
  docker run -d ${platform:+--platform "$platform"} "$@" >"$work/docker.$$" 2>&1 ||
    { cat "$work/docker.$$"; return 1; }
}

# Run a command on the current device ($dev).
device() { docker exec "$dev" sh -c "$1"; }

# Boot an OpenWrt device under procd, reachable on its Docker address, with
# the shared root password and key. Sets booted_ip and booted_model.
boot_device() {
  dev=$1
  run_container --name "$dev" --privileged "$image" /sbin/init
  # dropbear and netifd are up almost at once, but board.json is generated
  # later in boot; wait for what the tool reads, and for the LAN.
  device 'n=0; until { [ -s /etc/board.json ] && ubus call network.interface.lan status >/dev/null 2>&1 && pidof dropbear >/dev/null; } || [ $n -ge 90 ]; do sleep 1; n=$((n+1)); done; [ -s /etc/board.json ]'
  booted_ip=$(docker inspect "$dev" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
  gateway=$(docker inspect "$dev" --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}')
  booted_model=$(device 'jsonfilter -i /etc/board.json -e @.model.id')
  # netifd moves eth0 into br-lan at 192.168.1.1; put the LAN back on the
  # Docker address, directly on eth0, so the controller can reach it.
  device "uci set network.lan.device=eth0; uci set network.lan.ipaddr=$booted_ip; uci set network.lan.netmask=255.255.255.0; uci set network.lan.gateway=$gateway; uci commit network; reload_config"
  device 'n=0; until ip -4 addr show eth0 | grep -q "inet " || [ $n -ge 20 ]; do sleep 1; n=$((n+1)); done'
  # Inside the device: piping into `docker exec -i` from a background job has
  # hung on OrbStack. The password is hex, so it needs no quoting.
  device "printf '%s\\n%s\\n' $password $password | passwd root >/dev/null 2>&1"
  docker cp "$work/key.pub" "$dev:/etc/dropbear/authorized_keys" >/dev/null
  device 'chmod 600 /etc/dropbear/authorized_keys'
  # A scratch package for the hostile UCI value.
  device 'touch /etc/config/onctest'
}

# --- one client, end to end --------------------------------------------------

run_client() {
  client=$1
  dev=$prefix-$client-device
  ctl=$prefix-$client
  failures=0
  pass() { printf '  ok    %s\n' "$*"; }
  fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }

  boot_device "$dev"
  ip=$booted_ip model=$booted_model

  case $client in
    dbclient | openssh)
      run_container --name "$ctl" -v "$work:/work" "$image" sleep infinity
      docker exec "$ctl" sh -c 'mkdir -p /var/lock; apk update >/dev/null 2>&1; apk add quickjs >/dev/null 2>&1'
      if [ "$client" = openssh ]; then
        docker exec "$ctl" sh -c 'apk add openssh-client >/dev/null 2>&1; rm -f /usr/bin/dbclient'
      fi
      hosts=/root/.ssh/known_hosts
      [ "$client" = openssh ] && hosts=/root/.config/openwrt-configurator/known_hosts
      ;;
    node)
      docker run -d --platform "$node_platform" --name "$ctl" -v "$work:/work" -v "$root/node_modules:/nm:ro" \
        -e NODE_PATH=/nm "$node_image" sleep infinity >/dev/null
      hosts=/root/.config/openwrt-configurator/known_hosts
      ;;
    *) echo "unknown client $client" >&2; return 2 ;;
  esac
  auth=key
  [ "$client" = dbclient ] && auth=password

  # keep: everything not under test is excluded from the declarative reset.
  # wipe: dropbear is neither declared nor excluded, so the reset deletes it.
  # lockout: dropbear is declared, on a port nothing will reconnect to.
  # exact: keep, plus a package installed mid-run that ships its own config.
  for mode in keep wipe lockout exact; do
    jq -n --arg ip "$ip" --arg model "$model" --arg pw "$password" --arg auth "$auth" --arg mode "$mode" --arg note "$note" '
      {
        devices: [{
          model_id: $model, ipaddr: $ip, hostname: "onc-rig", tags: {},
          provisioning_config: { ssh_auth: (if $auth == "password"
            then { username: "root", password: $pw }
            else { username: "root", private_key_path: "/work/key" } end) }
        }],
        configs_to_not_reset: [{ ".if": "*", configs: (
          ["luci.*","rpcd.*","ucitrack.*","uhttpd.*","system.led","network.*",
           "firewall.*","dhcp.*","wireless.*","attendedsysupgrade.*"]
          + (if $mode == "keep" or $mode == "exact" then ["dropbear.*"] else [] end)) }],
        package_profiles: (if $mode == "exact" then [{ packages: ["irqbalance"] }] else [] end),
        config: ({ system: { system: [{ zonename: "UTC", timezone: "UTC0" }] },
                   onctest: { onctest: [{ ".name": "main", note: $note }] } }
          + (if $mode == "lockout"
             then { dropbear: { dropbear: [{ PasswordAuth: "on", RootPasswordAuth: "on", Port: 2223 }] } }
             elif $mode == "exact"
             then { irqbalance: { irqbalance: [{ ".name": "main", enabled: true }] } }
             else {} end))
      }' >"$work/$client-$mode.json"
  done

  onc() {
    case $client in
      node) docker exec -w /work -e ONC_TEST_MIN_CONFIRM_WINDOW=15 "$ctl" node /work/onc.cjs "$@" ;;
      *) docker exec -w /work -e ONC_TEST_MIN_CONFIRM_WINDOW=15 "$ctl" qjs --module /work/onc.mjs "$@" ;;
    esac
  }
  provision() { # mode
    onc provision "$client-$1.json" --confirm-timeout 30 --rollback reload >"$work/$client.out" 2>&1
  }
  show() { sed 's/^/        /' "$work/$client.out"; }
  # The device must end every scenario healthy: dropbear on 22, nothing staged,
  # no rollback files left once the watchdog has finished.
  device_is_clean() {
    device 'n=0; until [ -z "$(ls /tmp/onc-* 2>/dev/null)" ] || [ $n -ge 60 ]; do sleep 1; n=$((n+1)); done
      netstat -ltn | grep -q ":22 " && [ -z "$(uci changes)" ] && [ -z "$(ls /tmp/onc-* /tmp/.onc-* 2>/dev/null)" ]'
  }
  restore_dropbear() {
    device 'uci -q delete dropbear.main; uci set dropbear.main=dropbear; uci set dropbear.main.PasswordAuth=on
      uci set dropbear.main.RootPasswordAuth=on; uci set dropbear.main.Port=22; uci commit dropbear
      /etc/init.d/dropbear restart; n=0; until netstat -ltn | grep -q ":22 " || [ $n -ge 15 ]; do sleep 1; n=$((n+1)); done'
  }
  rolls_back() { # mode
    if ! provision "$1" && grep -q "was rolled back" "$work/$client.out" && device_is_clean; then
      pass "a config that cuts SSH off ($1) rolls itself back"
    else fail "a config that cuts SSH off ($1) rolls itself back"; show; restore_dropbear; fi
  }

  echo "== $client ($auth), device $model at $ip"

  if onc print-uci-commands "$client-keep.json" >/dev/null 2>&1 &&
    docker exec "$ctl" grep -q "^$ip " "$hosts"; then
    pass "first connect records the host key"
  else fail "first connect records the host key"; fi

  if provision keep && grep -q "^Confirmed." "$work/$client.out" && device_is_clean; then
    pass "a safe config is confirmed"
  else fail "a safe config is confirmed"; show; fi

  stored_sha=$(device 'uci -q get onctest.main.note | sha256sum | cut -d" " -f1')
  if [ "$stored_sha" = "$note_sha" ] && device '[ ! -e /tmp/pwned ]'; then
    pass "a value with quotes and \$(...) is stored exactly and runs nothing"
  else fail "a value with quotes and \$(...) is stored exactly and runs nothing"; fi

  if [ "$client" = dbclient ]; then
    # Someone's unfinished `uci set` in a package this run never touches, and
    # an unsaved LuCI edit (rpcd stages those per session, elsewhere). The
    # first must be reported and discarded, the second left alone.
    session=$(device "ubus call session login '{\"username\":\"root\",\"password\":\"$password\"}' | jsonfilter -e @.ubus_rpc_session")
    device "ubus call uci set '{\"config\":\"system\",\"section\":\"@system[0]\",\"values\":{\"hostname\":\"luci-pending\"},\"ubus_rpc_session\":\"$session\"}'"
    device 'uci set luci.main.lang=de'
    if provision keep &&
      grep -q "discarding uncommitted UCI changes in luci (1)" "$work/$client.out" &&
      device_is_clean &&
      [ "$(device 'uci -q get luci.main.lang')" != de ] &&
      device "ubus call uci changes '{\"ubus_rpc_session\":\"$session\"}' | grep -q luci-pending"; then
      pass "stray staged changes are discarded and reported; LuCI's are kept"
    else fail "stray staged changes are discarded and reported; LuCI's are kept"; show; fi

    # What the old reset missed: a section type only a package installed
    # during the run brings (irqbalance ships `config irqbalance 'irqbalance'`),
    # and a value whose second line reads like a section header.
    device "uci add onctest stray >/dev/null; uci set onctest.odd=thing
      uci set onctest.odd.v='x
config evil\$(touch /tmp/pwned2)[0]'; uci commit onctest"
    if provision exact && device_is_clean && device '[ ! -e /tmp/pwned2 ]' &&
      [ "$(device 'uci export irqbalance; uci show onctest | cut -d= -f1')" = "$(printf '%s\n' \
        'package irqbalance' '' "config irqbalance 'main'" "	option enabled '1'" '' \
        onctest.main onctest.main.note)" ]; then
      pass "the result is exactly the declared config, even where a package adds some"
    else fail "the result is exactly the declared config, even where a package adds some"; show
      device 'uci export irqbalance; uci show onctest | cut -d= -f1' | sed 's/^/        /'; fi

    rolls_back lockout
  fi
  [ "$client" != openssh ] && rolls_back wipe

  device 'rm -f /etc/dropbear/dropbear_*_host_key; /etc/init.d/dropbear restart; n=0; until netstat -ltn | grep -q ":22 " || [ $n -ge 15 ]; do sleep 1; n=$((n+1)); done'
  if ! onc print-uci-commands "$client-keep.json" >"$work/$client.out" 2>&1 &&
    grep -q "host key for $ip has changed" "$work/$client.out"; then
    pass "a changed host key is refused"
  else fail "a changed host key is refused"; show; fi

  return "$failures"
}

# --- two devices as one change ----------------------------------------------

run_network() {
  failures=0
  pass() { printf '  ok    %s\n' "$*"; }
  fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }
  ctl=$prefix-network
  a=$prefix-network-a
  b=$prefix-network-b
  boot_device "$a"
  ip_a=$booted_ip model=$booted_model
  boot_device "$b"
  ip_b=$booted_ip
  on() { docker exec "$1" sh -c "$2"; }
  clean_on() {
    on "$1" 'n=0; until [ -z "$(ls /tmp/onc-* 2>/dev/null)" ] || [ $n -ge 90 ]; do sleep 1; n=$((n+1)); done
      netstat -ltn | grep -q ":22 " && [ -z "$(uci changes)" ] && [ -z "$(ls /tmp/onc-* /tmp/.onc-* 2>/dev/null)" ]'
  }
  run_container --name "$ctl" -v "$work:/work" "$image" sleep infinity
  docker exec "$ctl" sh -c 'mkdir -p /var/lock; apk update >/dev/null 2>&1; apk add quickjs >/dev/null 2>&1'

  # together: both get a harmless change. partial: a's timezone changes, while
  # b's dropbear moves to a port nothing reconnects to — so b locks itself out,
  # and a's committed change must be undone too.
  for mode in together partial; do
    jq -n --arg a "$ip_a" --arg b "$ip_b" --arg model "$model" --arg pw "$password" --arg mode "$mode" '
      def device($name; $ip): {
        model_id: $model, ipaddr: $ip, hostname: $name, tags: {},
        provisioning_config: { ssh_auth: { username: "root", password: $pw } }
      };
      {
        devices: [device("onc-rig-a"; $a), device("onc-rig-b"; $b)],
        configs_to_not_reset: [
          { ".if": "*", configs: ["luci.*","rpcd.*","ucitrack.*","uhttpd.*","system.led","network.*",
                                  "firewall.*","dhcp.*","wireless.*","attendedsysupgrade.*","onctest.*"] },
          { ".if": (if $mode == "partial" then "device.hostname == \"onc-rig-a\"" else "*" end),
            configs: ["dropbear.*"] }
        ],
        config: ({
          system: { system: [{ zonename: "UTC", timezone: "UTC0", ".overrides": (
            if $mode == "partial"
            then [{ ".if": "device.hostname == \"onc-rig-a\"", override: { timezone: "EST5" } }]
            else [] end) }] }
        } + (if $mode == "partial" then { dropbear: { dropbear: [{
              ".if": "device.hostname == \"onc-rig-b\"",
              PasswordAuth: "on", RootPasswordAuth: "on", Port: 2223 }] } } else {} end))
      }' >"$work/network-$mode.json"
  done
  network() {
    docker exec -w /work -e ONC_TEST_MIN_CONFIRM_WINDOW=15 "$ctl" qjs --module /work/onc.mjs \
      provision "network-$1.json" --confirm-timeout 30 --rollback reload >"$work/network.out" 2>&1
  }

  echo "== network (two devices, dbclient), devices at $ip_a and $ip_b"

  if network together && grep -q "2 device(s) confirmed" "$work/network.out" &&
    clean_on "$a" && clean_on "$b"; then
    pass "two devices are confirmed together"
  else fail "two devices are confirmed together"; sed 's/^/        /' "$work/network.out"; fi

  if ! network partial && grep -q "cut off access to onc-rig-b" "$work/network.out" &&
    clean_on "$a" && clean_on "$b" &&
    [ "$(on "$a" 'uci get system.@system[0].timezone')" = UTC0 ]; then
    pass "one device cutting itself off rolls both back"
  else fail "one device cutting itself off rolls both back"; sed 's/^/        /' "$work/network.out"; fi

  return "$failures"
}

# --- run the clients in parallel ---------------------------------------------

started=$(date +%s)
for client in $clients; do
  job=run_client
  [ "$client" = network ] && job=run_network
  ($job "$client" >"$work/$client.log" 2>&1; echo $? >"$work/$client.status") &
done
wait

total=0
for client in $clients; do
  printf '\n'
  cat "$work/$client.log"
  status=$(cat "$work/$client.status" 2>/dev/null || echo 1)
  total=$((total + status))
done

printf '\n== result (%ss)\n' "$(($(date +%s) - started))"
if [ "$total" -eq 0 ]; then echo "  all scenarios passed"; else echo "  $total scenario(s) failed"; exit 1; fi
