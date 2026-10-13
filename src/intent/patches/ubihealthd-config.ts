import { Patch } from "./patch";

const script = "/usr/libexec/onc/ubihealthd-config";

export const ubihealthdConfig: Patch = {
  id: "ubihealthd-config",
  title: "Flash health monitoring kept running",
  affects: [],
  why:
    "ubihealthd's config (a section per UBI device) is written once, by a first-boot " +
    "script that deletes itself, so a config lost since is never made again and " +
    "ubihealthd silently runs nothing; and its init script registers no reload " +
    "trigger, so a changed or restored config only applies on a restart. Kept by " +
    "the wipe, made again from /sys/class/ubi when missing, and restarted when it was " +
    "(read from upstream mtd-utils on 25.12).",
  kind: "fix",
  references: [
    {
      kind: "docs",
      url: "https://github.com/openwrt/openwrt/tree/main/package/utils/mtd-utils/files",
      note: "the first-boot script that writes the config once, and the init script with no reload trigger",
    },
  ],
  added: "2026-10-12",
  verified: "read from mtd-utils on 25.12; the user's NWA50AX Pro (UBI) keeps its config",
  dropWhen: "ubihealthd's init script registers a reload trigger and its config is remade when missing",
  // Wherever it is installed: devices without UBI flash have neither the
  // config nor /sys/class/ubi, and the script does nothing there.
  target: {},
  apply: () => ({
    // "?": a device without UBI flash has no such config.
    keeps: [{ config: "ubihealthd", optional: true }],
    services: [{ name: "ubihealthd" }],
    files: [
      {
        path: script,
        mode: "0755",
        content: `#!/bin/sh
# As ubihealthd's first-boot script does, when its config has no UBI device
# (lost since first boot); then restart it, as it has no reload trigger.
# Otherwise nothing: its config is kept, not written, so nothing changed.
[ -x /etc/init.d/ubihealthd ] && [ -e /sys/class/ubi ] || exit 0
if ! uci -q show ubihealthd | grep -q '=ubi-device$'; then
	touch /etc/config/ubihealthd
	for d in /sys/class/ubi/*/total_eraseblocks; do
		[ -e "$d" ] || continue
		d="\${d%/*}"; d="\${d##*/}"
		uci batch <<EOF
set ubihealthd.$d=ubi-device
set ubihealthd.$d.device=/dev/$d
set ubihealthd.$d.enable=1
EOF
	done
	uci commit ubihealthd
	/etc/init.d/ubihealthd restart
fi
`,
        runAfterReload: script,
      },
    ],
  }),
};
