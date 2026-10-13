// What a firewall rule may be, given the rest of it.
import { internet } from "../access";
import type { Choice } from "../feature";
import { portsApply } from "./schema";

export const firewallRules: Choice[] = [
  {
    path: "firewall.rules.*.to",
    values: [internet],
    unavailable: (intent, [i]) =>
      intent.firewall.rules[Number(i)]?.from === internet &&
      "Traffic from the internet to the internet never passes the router.",
  },
  {
    path: "firewall.rules.*.from",
    values: [internet],
    unavailable: (intent, [i]) =>
      intent.firewall.rules[Number(i)]?.to === internet &&
      "Traffic from the internet to the internet never passes the router.",
    refuses: false,
  },
  {
    path: "firewall.rules.*.ports",
    unavailable: (intent, [i]) =>
      !portsApply(intent.firewall.rules[Number(i)]?.protocol) && "Ports only apply to TCP and UDP.",
    // Ignored for other protocols, and kept for when it is TCP or UDP again.
    refuses: false,
  },
];
