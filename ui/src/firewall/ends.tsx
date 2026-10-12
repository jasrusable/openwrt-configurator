// Shared by the firewall pages: where a rule's traffic comes from and goes
// to (a network, the internet, the router, anywhere), and how a rule reads.
import { useDraftValue } from "../form/draft";
import { Badge } from "@mantine/core";
import { anywhere, internet, router } from "../../../src/intent/firewall";
import { Intent } from "../../../src/intent/schema";
import { SelectField } from "../form/fields";
import { IntentField } from "../form/IntentForm";

export const actionOptions = [
  { value: "allow" as const, label: "Allow" },
  { value: "block" as const, label: "Block" },
];

export const ActionBadge = ({ action }: { action?: string }) => (
  <Badge variant="light" color={action === "allow" ? "green" : "red"}>
    {action === "allow" ? "Allow" : "Block"}
  </Badge>
);

export const protocolOptions = [
  { value: "tcp+udp" as const, label: "TCP and UDP" },
  { value: "tcp" as const, label: "TCP" },
  { value: "udp" as const, label: "UDP" },
  { value: "icmp" as const, label: "ICMP" },
  { value: "any" as const, label: "Any" },
];

/** The networks by name, with the internet, anywhere, and (as a destination) the router. */
export const useEndOptions = ({ destination }: { destination?: boolean } = {}) => {
  const networks: Intent["networks"] = useDraftValue("networks") ?? [];
  return [
    ...networks.map((n) => ({ value: n.id, label: n.name || "Unnamed" })),
    { value: internet, label: "The internet" },
    ...(destination ? [{ value: router, label: "The router" }] : []),
    { value: anywhere, label: "Anywhere" },
  ];
};

/** A rule's source or destination; what it may not be is greyed out by the rules (choices.ts). */
export const EndSelectField = ({
  destination,
  ...row
}: {
  name: IntentField;
  label: string;
  description?: string;
  destination?: boolean;
}) => <SelectField {...row} options={useEndOptions({ destination })} />;

/** "TCP from Guests to Home 10.0.0.20, port 631 9100": a rule, read aloud. */
export const useRuleSummary = (rule?: Intent["firewall"]["rules"][number]) => {
  const ends = useEndOptions({ destination: true });
  if (!rule) return "";
  const end = (id: string, addresses?: string[]) =>
    (ends.find((e) => e.value === id)?.label ?? id) +
    (addresses?.length ? ` ${addresses.join(", ")}` : "");
  const protocol =
    rule.protocol === "any"
      ? "Anything"
      : protocolOptions.find((p) => p.value === rule.protocol)?.label;
  const ports = rule.destination_port ? `, port ${rule.destination_port}` : "";
  return `${protocol} from ${end(rule.from, rule.source_addresses)} to ${end(rule.to, rule.destination_addresses)}${ports}`;
};
