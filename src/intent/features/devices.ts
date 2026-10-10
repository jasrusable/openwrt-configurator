// The devices to provision and how to reach them. No addresses in the intent:
// the router is the network's first address, every other device is found by
// name on the local domain (the router's DHCP and DNS put it there).
import { Feature, routerAddress } from "../fragment";

export const devices: Feature = (intent) => ({
  devices: intent.devices.map((device) => ({
    hostname: device.name,
    tags: { role: device.role },
    ipaddr:
      device.role === "router"
        ? routerAddress(intent)
        : `${device.name}.${intent.dns.local_domain}`,
    provisioning_config: {
      ssh_auth: {
        username: "root",
        ...(intent.admin.ssh_key_path
          ? { private_key_path: intent.admin.ssh_key_path }
          : {}),
        ...(intent.admin.password ? { password: intent.admin.password } : {}),
      },
    },
  })),
});
