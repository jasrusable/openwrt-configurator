// DNS & DHCP: how names are looked up, for the whole network; and an
// overview of each network's DHCP, which is edited on the network itself.
import { ActionIcon, Button, Group, Text, TextInput } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { useDraft, useDraftValue, useFieldError } from "../form/draft";
import {
  SelectField,
  SwitchField,
  TagsField,
  TextField,
  VariantField,
  When,
} from "../form/fields";
import { DataTable } from "../kit/DataTable";
import { Section, SettingsPage } from "../kit/layout";

type DnsRecord = { name: string; address: string };

const LocalNames = () => {
  const draft = useDraft();
  const records: DnsRecord[] = useDraftValue("dns.records") ?? [];
  const domain: string = useDraftValue("dns.local_domain") ?? "lan";
  const set = (next: DnsRecord[]) => draft.set("dns.records", next);
  return (
    <Section
      title="Local names"
      description={`Names for things that are not one device with a reserved address (those are named under Networks): name.${domain} answers with the address.`}
      actions={
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<IconPlus size={14} />}
          onClick={() => set([...records, { name: "", address: "" }])}
        >
          Add name
        </Button>
      }
    >
      {records.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          No local names.
        </Text>
      ) : (
        records.map((record, i) => (
          <RecordRow
            key={i}
            index={i}
            record={record}
            onChange={(next) =>
              set(records.map((old, j) => (j === i ? next : old)))
            }
            onRemove={() => set(records.filter((_, j) => j !== i))}
          />
        ))
      )}
    </Section>
  );
};

const RecordRow = ({
  index,
  record,
  onChange,
  onRemove,
}: {
  index: number;
  record: DnsRecord;
  onChange: (next: DnsRecord) => void;
  onRemove: () => void;
}) => {
  const nameError = useFieldError(`dns.records.${index}.name`);
  const addressError = useFieldError(`dns.records.${index}.address`);
  return (
    <Group gap="xs" px="md" py="sm" wrap="nowrap" align="flex-start">
      <TextInput
        aria-label="Name"
        placeholder="printer"
        value={record.name}
        onChange={(e) =>
          onChange({
            ...record,
            name: e.currentTarget.value
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, ""),
          })
        }
        error={nameError}
        spellCheck={false}
        style={{ flex: 1 }}
      />
      <TextInput
        aria-label="Address"
        placeholder="10.0.0.30"
        value={record.address}
        onChange={(e) =>
          onChange({
            ...record,
            address: e.currentTarget.value.replace(/[^0-9a-fA-F.:]/g, ""),
          })
        }
        error={addressError}
        spellCheck={false}
        ff="monospace"
        style={{ flex: 1 }}
      />
      <ActionIcon
        variant="subtle"
        color="gray"
        size={36}
        onClick={onRemove}
        aria-label="Remove"
      >
        <IconX size={16} />
      </ActionIcon>
    </Group>
  );
};

/** Each network's DHCP at a glance; it is edited on the network's page. */
const DhcpOverview = () => {
  const navigate = useNavigate();
  const networks: Intent["networks"] = useDraftValue("networks") ?? [];
  const pool = (n: Intent["networks"][number]) => {
    const prefix = n.subnet.split(".").slice(0, 3).join(".");
    return `${prefix}.${255 - n.dhcp.size} – ${prefix}.254`;
  };
  return (
    <Section
      title="DHCP"
      description="Addresses each network hands out. Open a network to change its range, lease time or reserved addresses."
    >
      <DataTable
        rowCount={networks.length}
        rowKey={(i) => networks[i].id}
        onRowClick={(i) => navigate(`/networks/${i}`)}
        empty={null}
        columns={[
          {
            header: "Network",
            cell: (i) => (
              <Text size="sm" fw={500}>
                {networks[i].name}
              </Text>
            ),
          },
          {
            header: "Addresses",
            cell: (i) => (
              <Text size="sm" c="dimmed" ff="monospace">
                {pool(networks[i])}
              </Text>
            ),
          },
          {
            header: "Lease",
            cell: (i) => (
              <Text size="sm" c="dimmed">
                {networks[i].dhcp.lease}
              </Text>
            ),
          },
          {
            header: "Reserved",
            cell: (i) => (
              <Text size="sm" c="dimmed">
                {networks[i].reservations?.length ?? 0}
              </Text>
            ),
          },
          {
            header: "DNS handed out",
            cell: (i) => (
              <Text size="sm" c="dimmed">
                {networks[i].dhcp.dns_servers?.join(", ") ?? "The router"}
              </Text>
            ),
          },
        ]}
      />
    </Section>
  );
};

export const DnsPage = () => (
  <SettingsPage
    title="DNS & DHCP"
    description="How names are looked up, and how devices get their addresses."
  >
    <Section
      title="DNS servers"
      description="Where the router looks up names for every device."
    >
      <VariantField
        name="dns.upstream"
        label="Use"
        variants={[
          {
            value: "provider",
            label: "Provider's",
            initial: { type: "provider" },
          },
          {
            value: "encrypted",
            label: "Encrypted",
            initial: { type: "encrypted", provider: "cloudflare" },
          },
          {
            value: "custom",
            label: "Custom",
            initial: { type: "custom", servers: [] },
          },
        ]}
      />
      <When name="dns.upstream.type" is="encrypted">
        <SelectField
          name="dns.upstream.provider"
          label="Provider"
          description="Lookups are encrypted, so your internet provider cannot see or change them."
          options={[
            { value: "cloudflare", label: "Cloudflare" },
            { value: "google", label: "Google" },
            { value: "quad9", label: "Quad9 (blocks known malware)" },
          ]}
        />
      </When>
      <When name="dns.upstream.type" is="custom">
        <TagsField
          name="dns.upstream.servers"
          label="Servers"
          description="Asked as they are, unencrypted. IPv4 or IPv6."
          placeholder="Add a server"
        />
      </When>
    </Section>
    <Section>
      <TextField
        name="dns.local_domain"
        label="Local domain"
        description="Devices are reachable as name.domain."
      />
      <SwitchField
        name="dns.rebind_protection"
        label="Rebind protection"
        description="Answers from the internet may not point at your own addresses, so a web page cannot reach devices inside. Some services (a few streaming and smart-home apps) need it off."
      />
    </Section>
    <LocalNames />
    <DhcpOverview />
  </SettingsPage>
);
