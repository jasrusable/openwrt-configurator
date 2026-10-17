// The device side of a firmware upgrade, as one fixed script: `onc-upgrade`.
// An upgrade writes it once per device (/tmp/onc-upgrade-<runId>.sh) and
// calls its verbs; what a verb needs comes on stdin, never in the script.
// The image goes straight from ASU into this device's RAM (/tmp), never
// through the machine running the app (a router has no flash to spare), and
// is checked here before sysupgrade sees it. Any failure removes it.
//
//   room <kb>         enough RAM for an image of <kb> and sysupgrade's own: refused before anything else
//   fetch < url sum   download the image into RAM; its sha256 checked here
//   check             sysupgrade -T: an image for this board
//   keep-self < dir   the device this app runs on: keep the app through the upgrade
//                     (its package's file, a one-shot reinstall at first boot, its
//                     feed and key, and <dir>, its settings and state, in
//                     sysupgrade's keep list)
//   flash             sysupgrade, keeping the settings, a moment after answering;
//                     the applied marker set first, so the image's first-boot
//                     defaults leave those settings alone (a device applied before
//                     the marker existed, or without a confirm, has none)
//   flash-keys        sysupgrade keeping only /etc/dropbear (host keys, authorized
//                     keys), from a tarball made here that never leaves the device:
//                     back to an older series, which must not be handed newer config
//   clean             the image, a download still running, what keep-self left, and
//                     this script gone
//
// Each says ONC_<WORD> on stdout when it went through; a failure says why on
// stderr and exits 1. It starts as the apply's agent does (src/agent/prelude.ts):
// out of the SSH session's cgroup (sysupgrade, started late and detached, must
// not stay in dropbear's), and a download kept off the session's streams. Paths grow from ONC_ROOT and ONC_TMP, so the whole
// script is tested under plain sh in a temp dir (upgrade.test.ts).

import { appliedKeepList, appliedMarker } from "../agent/paths";
import { prelude } from "../agent/prelude";

export const upgradeName = "onc-upgrade-";

/** Where a run's upgrade script lives on a device. */
export const upgradePath = (runId: string) => `/tmp/${upgradeName}${runId}.sh`;

/** This app's own package, and where the router it runs on keeps a copy of it through an upgrade. */
export const selfPackage = "openwrt-configurator";
export const selfPackageDir = "/etc/onc/pkg";
/** The key its feed is signed with (README), kept with the feed's own list so it updates after. */
export const selfFeedKey = "/etc/apk/keys/openwrt-configurator.pem";
/** Its one-shot reinstall at the first boot after the upgrade. */
export const selfReinstall = "/etc/uci-defaults/90-onc-reinstall";
/** What sysupgrade keeps for it. */
export const selfKeepList = "/lib/upgrade/keep.d/onc-self";

/** What RAM must hold beside the image: sysupgrade copies its tools into a ramfs and stops the services itself. */
export const headroomKb = 16 * 1024;

export const upgradeScript = `#!/bin/sh
# onc-upgrade: one device's firmware upgrade, for openwrt-configurator.
# See src/firmware/upgradeScript.ts.

ROOT="\${ONC_ROOT:-}"
TMP="\${ONC_TMP:-/tmp}"
SCRIPT="$0"
RUN="\${SCRIPT##*/${upgradeName}}"; RUN="\${RUN%.sh}"
IMAGE="$TMP/onc-firmware-$RUN.bin"
KEYS="$TMP/onc-keys-$RUN.tgz"
# A detached command's output (a download), and its pid while it runs.
OUT="$TMP/onc-fetch-$RUN"
FETCHING="$OUT.pid"
${prelude}

fail() { rm -f "$IMAGE" "$KEYS" "$FETCHING"; echo "onc-upgrade: $*" >&2; exit 1; }

# Free RAM, KiB: the less of /tmp's free space and the memory available
# (tmpfs takes its pages from memory, so its free space can be more than there is).
free_kb() {
	tmp=$(df -k "$TMP" 2>/dev/null | awk 'NR == 2 { print $4 }')
	mem=$(awk '/^MemAvailable:/ { print $2 }' "$ROOT/proc/meminfo" 2>/dev/null)
	free=$tmp
	[ -n "$mem" ] && { [ -z "$free" ] || [ "$mem" -lt "$free" ]; } && free=$mem
	echo "\${free:-0}"
}

room() {
	need=$(( $1 + ${headroomKb} ))
	free=$(free_kb)
	[ "$free" -ge "$need" ] || fail "$free KiB of RAM free; the image and sysupgrade need $need KiB"
	echo ONC_ROOM
}

# Detached, its pid kept while it runs: a call that timed out leaves it
# running (dropbear signals nothing), and clean stops it.
fetch() {
	read -r url; read -r sum
	rm -f "$IMAGE"
	detached uclient-fetch -q -T 60 -O "$IMAGE" "$url" || fail "could not download the image"
	got=$(sha256sum "$IMAGE" | cut -d ' ' -f 1)
	[ "$got" = "$sum" ] || fail "the image's sha256 is $got, not $sum"
	echo ONC_FETCHED
}

check() {
	[ -f "$IMAGE" ] || fail "no image to check"
	sysupgrade -T "$IMAGE" < /dev/null >&2 || fail "sysupgrade refuses the image for this board"
	echo ONC_CHECKED
}

# An upgrade keeps /etc/config and what keep.d lists, never packages installed
# since the image: so this app keeps its own package's file and installs it
# again, offline, at the first boot after (quickjs, its runtime, is in the
# image). A reinstall that fails is said in the log and left to run again at
# the next boot. Of the feeds, only the list naming this app's is kept: the
# release's own (distfeeds.list) names its release, and the new one's must stand.
keep_self() {
	read -r dir
	pkg="$ROOT${selfPackageDir}"
	mkdir -p "$pkg" "$ROOT/lib/upgrade/keep.d" "$ROOT/etc/uci-defaults"
	rm -f "$pkg"/*.apk
	# The index first: a router after a reboot has none cached.
	{ detached apk update && detached apk fetch -o "$pkg" "\${ONC_SELF_PACKAGE:-${selfPackage}}"; } ||
		fail "could not keep a copy of this app's own package"
	ls "$pkg"/*.apk > /dev/null 2>&1 || fail "could not keep a copy of this app's own package"
	cat > "$ROOT${selfReinstall}" <<-'EOF'
	#!/bin/sh
	# openwrt-configurator: back after an upgrade of the router it runs on, reinstalled from the copy kept
	# (checked against its feed's signed index when it was fetched, as the agent's staged packages are).
	# Failing, it stays, and runs again at the next boot.
	apk add --allow-untrusted --repositories-file /dev/null ${selfPackageDir}/*.apk && exit 0
	logger -t openwrt-configurator "could not reinstall itself from ${selfPackageDir} after the upgrade: tried again at the next boot"
	exit 1
	EOF
	feeds=$(grep -l -s '${selfPackage}' "$ROOT"/etc/apk/repositories.d/*.list | grep -v '/distfeeds\.list$')
	key=""; [ -f "$ROOT${selfFeedKey}" ] && key="${selfFeedKey}"
	{
		printf '%s\n' "$dir/" "${selfPackageDir}/" "${selfReinstall}" $key
		for f in $feeds; do echo "\${f#"$ROOT"}"; done
	} > "$ROOT${selfKeepList}"
	echo ONC_KEPT
}

# Detached and a moment late, so this answer leaves before sysupgrade stops
# dropbear; it keeps the settings (no -n), and reboots into the new release.
flash() {
	[ -f "$IMAGE" ] || fail "no image to flash"
	mkdir -p "$ROOT/etc/onc" "$ROOT/lib/upgrade/keep.d" && touch "$ROOT${appliedMarker}" &&
		echo "${appliedMarker}" > "$ROOT${appliedKeepList}" || fail "could not mark the settings to keep"
	setsid sh -c "sleep 1; exec sysupgrade '$IMAGE'" < /dev/null > /dev/null 2>&1 &
	echo ONC_FLASHING
}

# Back to an older series: none of the settings, only the SSH keys, so it comes
# up on the image's first-boot defaults under the same host key (no applied
# marker: those defaults run). The tarball is made here and stays in RAM.
flash_keys() {
	[ -f "$IMAGE" ] || fail "no image to flash"
	tar -czf "$KEYS" -C "$ROOT/" etc/dropbear 2> /dev/null || fail "could not keep the SSH keys"
	setsid sh -c "sleep 1; exec sysupgrade -f '$KEYS' '$IMAGE'" < /dev/null > /dev/null 2>&1 &
	echo ONC_FLASHING
}

clean() {
	[ -f "$FETCHING" ] && kill "$(cat "$FETCHING")" 2> /dev/null
	rm -f "$IMAGE" "$KEYS" "$FETCHING" "$OUT" "$ROOT${selfReinstall}" "$ROOT${selfKeepList}" "$SCRIPT"
	echo ONC_CLEAN
}

leave_session_cgroup

case "$1" in
	room) room "$2" ;;
	fetch) fetch ;;
	check) check ;;
	keep-self) keep_self ;;
	flash) flash ;;
	flash-keys) flash_keys ;;
	clean) clean ;;
	*) echo "onc-upgrade: unknown verb $1" >&2; exit 2 ;;
esac
`;
