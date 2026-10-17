// DNS & DHCP: how names are looked up, for the whole network; and an
// overview of each network's DHCP, which is edited on the network itself.
import { Button, Text } from "@mantine/core";
import { IconPlus, IconWorldWww } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { useDraftList, useDraftValue } from "../form/draft";
import {
  dnsLabel,
  ItemColumns,
  ItemRow,
  ItemText,
  SelectField,
  SwitchField,
  TagsField,
  TextField,
  VariantField,
  When,
} from "../form/fields";
import { DataTable } from "../kit/DataTable";
import { EmptyState, Section, SettingsPage } from "../kit/layout";
import { poolStart } from "../../../src/intent/networks";
import { shownName } from "../../../src/intent/labels";

const LocalNames = () => {
  const records = useDraftList("dns.hosts");
  const domain: string = useDraftValue("dns.domain") ?? "lan";
  return (
    <Section
      title="Local names"
      description={`Names that answer on every network, like printer.${domain}.`}
      actions={
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<IconPlus size={14} />}
          onClick={() => records.add({ name: "", address: "" })}
        >
          Add name
        </Button>
      }
    >
      {records.items.length === 0 ? (
        <EmptyState icon={IconWorldWww}>No local names.</EmptyState>
      ) : (
        <>
          <ItemColumns
            columns={[
              { label: "Name", flex: 1 },
              { label: "Address", flex: 1 },
            ]}
          />
          {records.items.map((record, i) => (
            <ItemRow key={i} onRemove={() => records.remove(i)} removeLabel={`Remove ${record.name || "name"}`}>
              <ItemText name={`dns.hosts.${i}.name`} label="Name" placeholder="printer" tidy={dnsLabel} />
              <ItemText
                name={`dns.hosts.${i}.address`}
                label="Address"
                placeholder="10.0.0.30"
                tidy={(typed) => typed.replace(/[^0-9a-fA-F.:]/g, "")}
                mono
              />
            </ItemRow>
          ))}
        </>
      )}
    </Section>
  );
};

/** Each network's DHCP at a glance; it is edited on the network's page. */
const DhcpOverview = () => {
  const navigate = useNavigate();
  const networks: Intent["networks"] = useDraftValue("networks") ?? [];
  const pool = (n: Intent["networks"][number]) => {
    const prefix = n.subnet.split(".").slice(0, 3).join(".");
    return `${prefix}.${poolStart(n)} – ${prefix}.254`;
  };
  return (
    <Section
      title="DHCP"
      description="Each network's addresses. Open one to change it."
    >
      <DataTable
        rowCount={networks.length}
        rowKey={(i) => networks[i].id}
        onRowClick={(i) => navigate(`/settings/networks/${i}`)}
        empty={null}
        columns={[
          {
            header: "Network",
            cell: (i) => (
              <Text size="sm" fw={500}>
                {shownName(networks[i].name)}
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
        <SelectField
          name="dns.upstream.fallback"
          label="Fallback"
          emptyLabel="Automatic"
          options={[
            { value: "cloudflare", label: "Cloudflare" },
            { value: "google", label: "Google" },
            { value: "quad9", label: "Quad9" },
            { value: "none", label: "None" },
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
      />
      <SwitchField
        name="dns.rebind_protection"
      />
    </Section>
    <LocalNames />
    <DhcpOverview />
  </SettingsPage>
);
