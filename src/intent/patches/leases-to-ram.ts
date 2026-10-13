import { Patch } from "./patch";

const script = "/usr/libexec/onc/leases-to-ram";

export const leasesToRam: Patch = {
  id: "leases-to-ram",
  why:
    "Leases moved from /etc/dhcp.leases (flash, an older layout of this app's) to OpenWrt's own " +
    "/tmp/dhcp.leases. dnsmasq restarted on the new, empty file would forget every client's name " +
    "until it renews (hours): an access point reached as name.lan would vanish mid-apply. The " +
    "leases are copied over before the restart, once; the old file stays, so a rollback to it " +
    "finds them. Drop once no device has /etc/dhcp.leases.",
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
