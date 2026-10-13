// The devices to provision and how to reach them. No addresses in the intent:
// the router is the network's first address, every other device is found by
// name on the local domain (the router's DHCP and DNS put it there).
import { Feature, routerAddress } from "../fragment";

export const devices: Feature = (intent) => ({
  devices: intent.hardware.map((device) => ({
    hostname: device.name,
    // Reached over the mesh, through a cabled one: changed first, while the
    // path to it is still the one it has.
    ...(intent.wifi.mesh.enabled && device.uplink === "mesh" ? { provision_order: -1 } : {}),
    tags: { role: device.role, ...(intent.wifi.mesh.enabled && device.uplink === "mesh" ? { uplink: "mesh" } : {}) },
    ipaddr:
      device.role === "router"
        ? routerAddress(intent)
        : `${device.name}.${intent.dns.domain}`,
    provisioning_config: {
      ssh_auth: {
        username: "root",
        ...(intent.system.app_login.key
          ? { private_key_path: intent.system.app_login.key }
          : {}),
        ...(intent.system.app_login.password ? { password: intent.system.app_login.password } : {}),
      },
    },
  })),
});
