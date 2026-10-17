// Your own names: each an address, each name once and no device's (each
// device, reserved address included, is already name.<domain>).
import { isIpAddress } from "../addresses";
import type { FeatureModule } from "../feature";

export const dnsChecks: FeatureModule["check"] = (intent, issue) => {
  const devices = [...intent.hardware.map((d) => d.name), ...intent.networks.flatMap((n) => n.dhcp.reservations.map((r) => r.name))];
  intent.dns.hosts.forEach((record, i) => {
    if (!isIpAddress(record.address)) {
      issue(["dns", "hosts", i, "address"], "an IP address, like 10.0.0.20");
    }
    if (intent.dns.hosts.slice(0, i).some((r) => r.name === record.name)) {
      issue(["dns", "hosts", i, "name"], "already used");
    } else if (devices.includes(record.name)) {
      issue(["dns", "hosts", i, "name"], "already a device's name");
    }
  });
};
