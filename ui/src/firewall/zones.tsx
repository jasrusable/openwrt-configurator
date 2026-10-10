// Shared by the firewall pages: zone choices and labels, policy choices, and
// how a rule reads in a list (as LuCI words it).
import { Badge } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { zoneLabel } from "../../../src/intent/firewall";
import { Intent } from "../../../src/intent/schema";
import { SelectField } from "../form/fields";
import { IntentField } from "../form/IntentForm";

export const policyOptions = [
  { value: "accept" as const, label: "Accept" },
  { value: "reject" as const, label: "Reject" },
  { value: "drop" as const, label: "Drop" },
];

export const policyColor = (policy?: string) =>
  policy === "accept" ? "green" : policy === "reject" ? "orange" : "red";

export const PolicyBadge = ({ policy }: { policy?: string }) => (
  <Badge variant="light" color={policyColor(policy)}>
    {policyOptions.find((p) => p.value === policy)?.label ?? policy}
  </Badge>
);

/** The zones, labelled; and "any zone" or the router itself where allowed. */
export const useZoneOptions = ({
  any,
  router,
}: { any?: boolean; router?: boolean } = {}) => {
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  const zones: Intent["firewall"]["zones"] =
    useWatch({ name: "firewall.zones" }) ?? [];
  return [
    ...(router ? [{ value: "router", label: "Device (input)" }] : []),
    ...zones.map((zone) => ({
      value: zone.id,
      label: zoneLabel(zone, networks),
    })),
    ...(any ? [{ value: "*", label: "Any zone" }] : []),
  ];
};

/** A zone's name, from its id, as the user knows it. */
export const ZoneName = ({ id }: { id: string }) => {
  const options = useZoneOptions({ any: true, router: true });
  return <>{options.find((o) => o.value === id)?.label ?? id}</>;
};

export const ZoneSelectField = ({
  any,
  router,
  ...row
}: {
  name: IntentField;
  label: string;
  description?: string;
  any?: boolean;
  router?: boolean;
}) => <SelectField {...row} options={useZoneOptions({ any, router })} />;

const protocolNames: Record<string, string> = {
  tcp: "TCP",
  udp: "UDP",
  icmp: "ICMP",
  igmp: "IGMP",
  esp: "ESP",
  ah: "AH",
  sctp: "SCTP",
  all: "any protocol",
};
export const protocolOptions = Object.entries(protocolNames).map(
  ([value, label]) => ({
    value,
    label: value === "all" ? "Any" : label,
  }),
);

/** "Incoming IPv4, UDP from WAN to this device, port 68": a rule, as LuCI reads it. */
export const useRuleSummary = (rule?: Intent["firewall"]["rules"][number]) => {
  const zones = useZoneOptions({ any: true, router: true });
  if (!rule) return "";
  const zone = (id: string) =>
    id === "router"
      ? "this device"
      : (zones.find((z) => z.value === id)?.label ?? id);
  const direction = rule.to === "router" ? "Incoming" : "Forwarded";
  const family =
    rule.family === "any" ? "" : rule.family === "ipv4" ? " IPv4" : " IPv6";
  const protocols = rule.protocols.map((p) => protocolNames[p] ?? p).join(", ");
  const types = rule.icmp_types?.length
    ? ` (${rule.icmp_types.join(", ")})`
    : "";
  const source = rule.source_addresses?.length
    ? ` ${rule.source_addresses.join(", ")}`
    : "";
  const destination = rule.destination_addresses?.length
    ? ` ${rule.destination_addresses.join(", ")}`
    : "";
  const port = rule.destination_port ? `, port ${rule.destination_port}` : "";
  return `${direction}${family}, ${protocols}${types} from ${zone(rule.from)}${source} to ${zone(rule.to)}${destination}${port}`;
};
