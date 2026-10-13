// The hardware list, compiled: the devices to provision and how to reach
// them, and what each role needs beyond the features. No addresses in the
// intent: the router is the network's first address, every other device is
// found by name on the local domain (the router's DHCP and DNS put it there).
import { section } from "../../plan/types";
import { Feature, onAccessPoints, routerAddress } from "../fragment";

export const devices: Feature = (intent) => ({
  devices: intent.hardware.map((device) => ({
    hostname: device.name,
    // Reached over the mesh, through a cabled one: changed first, while the
    // path to it is still the one it has.
    ...(intent.wifi.mesh.enabled && device.uplink === "mesh" ? { provisionOrder: -1 } : {}),
    tags: { role: device.role, ...(intent.wifi.mesh.enabled && device.uplink === "mesh" ? { uplink: "mesh" } : {}) },
    ipaddr:
      device.role === "router"
        ? routerAddress(intent)
        : `${device.name}.${intent.dns.domain}`,
    login: {
      username: "root",
      ...(intent.system.app_login.key ? { privateKeyPath: intent.system.app_login.key } : {}),
      ...(intent.system.app_login.password ? { password: intent.system.app_login.password } : {}),
    },
  })),
});

/** What a role needs beyond the features. Fixes over OpenWrt are in patches/. */
export const roles: Feature = () => ({
  packages: [
    {
      // An access point routes nothing: no firewall, DHCP/DNS or PPPoE.
      when: onAccessPoints,
      remove: ["firewall4", "dnsmasq", "odhcpd-ipv6only", "ppp-mod-pppoe"],
    },
  ],
  config: {
    // Shipped by the full wpad; no RADIUS server is wanted.
    radius: { radius: [section({ when: onAccessPoints }, { disabled: true })] },
  },
});
