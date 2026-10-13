// The internet lines' rules across settings: a line's id once, and a
// static line's address, gateway and DNS making sense together.
import { parseCidr, parseIpv4 } from "../addresses";
import type { FeatureModule } from "../feature";
import { where } from "../places";

export const internetChecks: FeatureModule["check"] = (intent, issue) =>
  intent.internet.lines.forEach((line, c) => {
    if (intent.internet.lines.slice(0, c).some((other) => other.id === line.id)) {
      issue(["internet", "lines", c, "id"], "already used by another line");
    }
    if (line.type !== "static") return;
    const connection = line.static;
    const at = (key: string) => ["internet", "lines", c, "static", key];
    const address = parseIpv4(connection.address);
    const gateway = parseIpv4(connection.gateway);
    const size = 2 ** (32 - connection.prefix_length);
    if (address !== undefined) {
      const offset = address % size;
      if (offset === 0 || offset === size - 1) {
        issue(at("address"), "the subnet's own or broadcast address, not a host's");
      }
      if (gateway !== undefined && Math.floor(gateway / size) !== Math.floor(address / size)) {
        issue(at("gateway"), "not in the address's subnet");
      } else if (gateway === address) {
        issue(at("gateway"), "the router's own address");
      }
    }
    // The provider's subnet over one of ours: the router could not tell
    // which side an address is on, and that network would lose the internet.
    const clash =
      address === undefined
        ? undefined
        : intent.networks.find((n) => {
            const start = address - (address % size);
            const ours = parseCidr(n.subnet);
            return !!ours && start < ours.start + ours.size && ours.start < start + size;
          });
    if (clash) issue(at("address"), `the provider's range overlaps “${clash.name}” (${clash.subnet}): give one of them another range`);
    if (!connection.dns?.length && intent.dns.upstream.type === "provider") {
      issue(at("dns"), `add a DNS server, or choose other DNS servers under ${where("dns")}`);
    }
  });
