// Who may reach whom, at a glance: a row per source zone, a column per
// destination (each zone, WAN, and the router itself). Between two zones a
// cell is a forwarding, toggled by clicking; a zone to itself shows its
// forward policy and to the router its input policy, both set on the zone.
// Nothing is forwarded from WAN here: inbound traffic is port forwarding.
import { Badge, Paper, Table, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { useNavigate } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { useIntentForm } from "../form/IntentForm";
import { PolicyBadge, useZoneOptions } from "./zones";

export const ZoneMatrix = () => {
  const form = useIntentForm();
  const navigate = useNavigate();
  const firewall: Intent["firewall"] = useWatch({ name: "firewall" });
  const zones = useZoneOptions({});
  const sources = [...zones, { value: "wan", label: "WAN" }];
  const destinations = [...sources, { value: "router", label: "Router" }];
  const zone = (id: string) => firewall.zones.find((z) => z.id === id);
  const forwarded = (from: string, to: string) =>
    firewall.forwardings.some((f) => f.from === from && f.to === to);
  const ruleCount = (from: string, to: string) =>
    firewall.rules.filter((r) => r.from === from && r.to === to).length;

  const toggle = (from: string, to: string) =>
    form.setValue(
      "firewall.forwardings",
      forwarded(from, to)
        ? firewall.forwardings.filter((f) => !(f.from === from && f.to === to))
        : [...firewall.forwardings, { from, to }],
      { shouldDirty: true, shouldValidate: true }
    );

  const cell = (from: string, to: string) => {
    const rules = ruleCount(from, to);
    const extra = rules > 0 && (
      <Text span size="xs" c="dimmed" ml={6}>
        +{rules} rule{rules === 1 ? "" : "s"}
      </Text>
    );
    if (from === "wan") {
      const policy = to === "router" ? "reject" : to === "wan" ? undefined : "drop";
      return policy ? (
        <Tooltip label="From the internet, only port forwards and rules get in">
          <span>
            <PolicyBadge policy={policy} />
            {extra}
          </span>
        </Tooltip>
      ) : (
        <Text c="dimmed">—</Text>
      );
    }
    const source = zone(from)!;
    const zonePage = () =>
      navigate(`/firewall/zones/${firewall.zones.indexOf(source)}`);
    if (to === "router" || to === from) {
      return (
        <UnstyledButton onClick={zonePage}>
          <PolicyBadge policy={to === "router" ? source.input : source.forward} />
          {to === "router" && source.router_services && source.input !== "accept" && (
            <Text span size="xs" c="dimmed" ml={6}>
              + services
            </Text>
          )}
          {extra}
        </UnstyledButton>
      );
    }
    const allowed = forwarded(from, to);
    return (
      <UnstyledButton onClick={() => toggle(from, to)}>
        <Badge variant={allowed ? "filled" : "outline"} color={allowed ? "green" : "gray"}>
          {allowed ? "Allow" : "Block"}
        </Badge>
        {extra}
      </UnstyledButton>
    );
  };

  return (
    <Paper withBorder radius="lg" style={{ overflow: "auto" }}>
      <Table verticalSpacing="sm" horizontalSpacing="md" withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>
              <Text size="xs" c="dimmed" fw={500}>
                From ↓ / To →
              </Text>
            </Table.Th>
            {destinations.map((d) => (
              <Table.Th key={d.value}>
                <Text size="sm" fw={600}>
                  {d.label}
                </Text>
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sources.map((s) => (
            <Table.Tr key={s.value}>
              <Table.Td>
                <Text size="sm" fw={600}>
                  {s.label}
                </Text>
              </Table.Td>
              {destinations.map((d) => (
                <Table.Td key={d.value}>{cell(s.value, d.value)}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
};
