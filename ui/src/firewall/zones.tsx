// Shared by the firewall pages: zone choices and labels, and policy choices.
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

/** The zones, labelled; WAN and the router itself where a choice allows. */
export const useZoneOptions = ({ wan, router }: { wan?: boolean; router?: boolean }) => {
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  const zones: Intent["firewall"]["zones"] = useWatch({ name: "firewall.zones" }) ?? [];
  return [
    ...zones.map((zone) => ({ value: zone.id, label: zoneLabel(zone, networks) })),
    ...(wan ? [{ value: "wan", label: "WAN (internet)" }] : []),
    ...(router ? [{ value: "router", label: "Router (input)" }] : []),
  ];
};

/** A zone's name, from its id, as the user knows it. */
export const ZoneName = ({ id }: { id: string }) => {
  const options = useZoneOptions({ wan: true, router: true });
  return <>{options.find((o) => o.value === id)?.label ?? id}</>;
};

export const ZoneSelectField = ({
  wan,
  router,
  ...row
}: {
  name: IntentField;
  label: string;
  description?: string;
  wan?: boolean;
  router?: boolean;
}) => <SelectField {...row} options={useZoneOptions({ wan, router })} />;
