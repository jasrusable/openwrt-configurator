import { Text } from "@mantine/core";
import { IconArrowBarToRight } from "@tabler/icons-react";
import { useDraftValue } from "../../form/draft";
import { ItemIcon, ItemName } from "../../kit/layout";
import {
  SegmentedField,
  SwitchField,
  TagsField,
  TextField,
  Value,
} from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { Section } from "../../kit/layout";
import { portProtocolOptions } from "../../../../src/intent/labels";

/** Traffic let in from the internet, grey while the forward is off. */
const ForwardIcon = ({ index }: { index: number }) => {
  const on = useDraftValue(`firewall.port_forwards.${index}.enabled`) !== false;
  return <ItemIcon icon={IconArrowBarToRight} color="teal" off={!on} />;
};

const forwards = defineList({
  name: "firewall.port_forwards",
  title: "Port forwarding",
  description: "Let the internet reach a device at home.",
  addLabel: "Add port forward",
  newItem: () => ({
    name: "",
    enabled: true,
    protocol: "tcp" as const,
    port: "",
    to: { address: "" },
    reflection: true,
  }),
  itemTitle: (i) => (
    <Value
      name={`firewall.port_forwards.${i}.name`}
      fallback="New port forward"
    />
  ),
  empty: "Nothing is forwarded.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<ForwardIcon index={i} />}>
          <Value name={`firewall.port_forwards.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    {
      header: "External",
      cell: (i) => (
        <Text size="sm" ff="monospace">
          <Value
            name={`firewall.port_forwards.${i}`}
            format={(f) =>
              f && `${f.protocol.toUpperCase()} ${f.port}`
            }
          />
        </Text>
      ),
    },
    {
      header: "To",
      cell: (i) => (
        <Text size="sm" ff="monospace">
          <Value
            name={`firewall.port_forwards.${i}`}
            format={(f) =>
              f && `${f.to.address}:${f.to.port || f.port}`
            }
          />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`firewall.port_forwards.${i}.name`} />
        <SwitchField
          name={`firewall.port_forwards.${i}.enabled`}
        />
      </Section>
      <Section title="Forward">
        <SegmentedField
          name={`firewall.port_forwards.${i}.protocol`}
          options={portProtocolOptions}
        />
        <TextField
          name={`firewall.port_forwards.${i}.port`}
        />
        <TextField
          name={`firewall.port_forwards.${i}.to.address`}
          placeholder="10.0.0.50"
        />
        <TextField
          name={`firewall.port_forwards.${i}.to.port`}
          placeholder="Same"
        />
      </Section>
      <Section title="Advanced">
        <TagsField
          name={`firewall.port_forwards.${i}.from_addresses`}
          placeholder="203.0.113.7"
        />
        <SwitchField
          name={`firewall.port_forwards.${i}.reflection`}
        />
      </Section>
    </>
  ),
});

export const PortForwardsPage = ({ sub }: { sub: string }) => (
  <ListPage list={forwards} sub={sub} />
);
