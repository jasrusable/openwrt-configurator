// DNS & DHCP: how names are looked up, for the whole network; and an
// overview of each network's DHCP, which is edited on the network itself.
import { ActionIcon, Button, Group, Text, TextInput } from "@mantine/core";
import { IconPlus, IconWorldWww, IconX } from "@tabler/icons-react";
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
import { EmptyState, Section, SettingsPage } from "../kit/layout";

type DnsRecord = { name: string; address: string };

const LocalNames = () => {
  const draft = useDraft();
  const records: DnsRecord[] = useDraftValue("dns.hosts") ?? [];
  const domain: string = useDraftValue("dns.domain") ?? "lan";
  const set = (next: DnsRecord[]) => draft.set("dns.hosts", next);
  return (
    <Section
      title="Local names"
      description={`Names that answer on every network, like printer.${domain}.`}
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
        <EmptyState icon={IconWorldWww}>No local names.</EmptyState>
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
  const nameError = useFieldError(`dns.hosts.${index}.name`);
  const addressError = useFieldError(`dns.hosts.${index}.address`);
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
    return `${prefix}.${255 - n.dhcp.pool_size} – ${prefix}.254`;
  };
  return (
    <Section
      title="DHCP"
      description="Each network's addresses. Open one to change it."
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
                {networks[i].dhcp.reservations?.length ?? 0}
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
    description="Name lookups, and addresses for devices."
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
          description="Your provider cannot see or change lookups."
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
        name="dns.domain"
        label="Local domain"
        description="Devices are reachable as name.domain."
      />
      <SwitchField
        name="dns.rebind_protection"
        label="Rebind protection"
        description="Stops web pages from reaching devices at home."
      />
    </Section>
    <LocalNames />
    <DhcpOverview />
  </SettingsPage>
);
