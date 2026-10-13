// Your own names: each an address, and each name once.
import { isIpAddress } from "../addresses";
import type { FeatureModule } from "../feature";

export const dnsChecks: FeatureModule["check"] = (intent, issue) =>
  intent.dns.hosts.forEach((record, i) => {
    if (!isIpAddress(record.address)) {
      issue(["dns", "hosts", i, "address"], "an IP address, like 10.0.0.20");
    }
    if (intent.dns.hosts.slice(0, i).some((r) => r.name === record.name)) {
      issue(["dns", "hosts", i, "name"], "already used");
    }
  });
