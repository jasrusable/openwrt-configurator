import { Patch } from "./patch";

const script = "/etc/hotplug.d/net/30-onc-eee-off";

export const nwa50axEeeOff: Patch = {
  id: "nwa50ax-eee-off",
  title: "Energy Efficient Ethernet off on the NWA50AX Pro's port",
  affects: [],
  why:
    "The NWA50AX Pro's 2.5G port (MaxLinear GPY211 PHY) drops its link and renegotiates every " +
    "few minutes to hours with Energy Efficient Ethernet on, depending on the switch and cable; " +
    "EEE off keeps 2.5G (costing well under 1 W). netifd's own `eee` option uses an interface " +
    "this PHY driver refuses, so ethtool sets it, at each time the port appears.",
  kind: "fix",
  references: [
    { kind: "issue", url: "https://github.com/openwrt/openwrt/issues/14192", note: "Gigabit link instabilities with MaxLinear GPY211 (NWA50AX Pro, TUF-AX4200)" },
    { kind: "pr", url: "https://github.com/openwrt/netifd/pull/80", note: "netifd: configure EEE via ethtool netlink (open): then UCI `eee 0`" },
    { kind: "report", url: "https://github.com/openwrt/openwrt/issues/14192", note: "one eth0 down/up 3 s apart on the user's AP, 2026-10-12 21:57" },
  ],
  added: "2026-10-13",
  verified: "Docker 25.12.5: ethtool-full installs and the hook runs (a veth refuses EEE, quietly)",
  dropWhen: "netifd PR #80 is in a release (then a device section's `eee 0`), or the device tree marks the PHY eee-broken",
  target: { models: ["zyxel,nwa50ax-pro"], roles: ["access-point"] },
  apply: () => ({
    packages: { add: ["ethtool-full"] },
    files: [
      {
        path: script,
        mode: "0755",
        content: `#!/bin/sh
# nwa50ax-eee-off: Energy Efficient Ethernet off on eth0 (GPY211 link drops,
# openwrt#14192), whenever the port appears; quiet where EEE is not offered.
[ "$ACTION" = add ] || exit 0
[ "$INTERFACE" = eth0 ] || exit 0
command -v ethtool >/dev/null || exit 0
ethtool --set-eee eth0 eee off tx-lpi off >/dev/null 2>&1 || true
`,
        // Now as well, when first written or changed: the port is already up.
        runAfter: `ACTION=add INTERFACE=eth0 sh ${script}`,
      },
    ],
  }),
};
