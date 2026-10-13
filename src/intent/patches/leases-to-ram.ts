import { Patch } from "./patch";

const script = "/usr/libexec/onc/leases-to-ram";

export const leasesToRam: Patch = {
  id: "leases-to-ram",
  title: "DHCP leases carried into RAM, once",
  required: true,
  affects: [],
  why:
    "Leases moved from /etc/dhcp.leases (flash, an older layout of this app's) to OpenWrt's own " +
    "/tmp/dhcp.leases. dnsmasq restarted on the new, empty file would forget every client's name " +
    "until it renews (hours): an access point reached as name.lan would vanish mid-apply. The " +
    "leases are copied over before the restart, once; the old file stays, so a rollback to it " +
    "finds them. Drop once no device has /etc/dhcp.leases.",
  kind: "tuning",
  references: [
    {
      kind: "docs",
      url: "https://github.com/openwrt/openwrt/blob/openwrt-25.12/package/network/services/dnsmasq/files/dhcp.conf",
      note: "25.12's own leasefile, /tmp/dhcp.leases",
    },
  ],
  added: "2026-10-12",
  verified: "Docker 25.12.5: an old /etc/dhcp.leases carried over before dnsmasq restarted",
  dropWhen: "no device has /etc/dhcp.leases any more",
  target: { roles: ["router"] },
  apply: () => ({
    files: [
      {
        path: script,
        mode: "0755",
        content: `#!/bin/sh
# Leases from the old flash file into RAM, where dnsmasq now keeps them, before
# it restarts on the new path; never over leases already there.
[ -s /etc/dhcp.leases ] || exit 0
[ -s /tmp/dhcp.leases ] && exit 0
cp /etc/dhcp.leases /tmp/dhcp.leases
`,
        // When first written: during staging, before the commit restarts dnsmasq.
        runAfter: script,
      },
    ],
  }),
};
