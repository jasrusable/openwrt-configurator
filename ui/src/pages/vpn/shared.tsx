// What the VPN's pages share: a zone's access, set as a network's is, and
// a client's file and QR code, shown once.
import { Alert, Box, Button, Group, Stack, Text } from "@mantine/core";
import { ReactNode } from "react";
import { IconDownload } from "@tabler/icons-react";
import { renderSVG } from "uqr";
import { vpnZones } from "../../../../src/intent/vpn";
import { Intent } from "../../../../src/intent/schema";
import { useDraftValue } from "../../form/draft";
import { MultiSelectField, SegmentedField, SwitchField } from "../../form/fields";
import { ExperimentalBadge, Section } from "../../kit/layout";

const zoneLabels: Record<string, string> = { vpn: "Remote access clients", sites: "Linked sites" };

/** A VPN page's title, marked experimental: tested in containers, not yet on real routers. */
export const Experimental = ({ children }: { children: ReactNode }) => (
  <Group gap={10}>
    {children}
    <ExperimentalBadge />
  </Group>
);

/** What a zone may reach: every network, and the VPN's other zone. */
const useTargets = (self: "vpn" | "sites") => {
  const intent: Intent = useDraftValue();
  return [
    ...intent.networks.map((n) => ({ value: n.id, label: n.name || "Unnamed" })),
    ...vpnZones(intent)
      .filter((z) => z !== self)
      .map((z) => ({ value: z, label: zoneLabels[z] })),
  ];
};

/** Internet, networks and router access for the VPN's clients or the linked sites, as for a network. */
export const ZoneAccess = ({ base }: { base: "vpn" | "sites" }) => {
  const targets = useTargets(base);
  return (
    <Section title="Access" description="Replies always get back.">
      <SwitchField name={`${base}.access.internet`} label="Internet" />
      <MultiSelectField name={`${base}.access.networks`} label="Can reach" options={targets} placeholder="None" />
      <SegmentedField
        name={`${base}.access.router`}
        label="Router access"
        options={[
          { value: "services", label: "Network services" },
          { value: "full", label: "Full" },
        ]}
      />
    </Section>
  );
};

/** A WireGuard file, as a QR code to scan and a file to save: shown once, as nothing keeps its private key. */
export const KeyPanel = ({ name, conf, onDone }: { name: string; conf: string; onDone: () => void }) => {
  const download = () => {
    const url = URL.createObjectURL(new Blob([conf], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${name || "client"}.conf` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Section title="Set it up now" description="Scan it with the WireGuard app, or save the file. It is shown only now.">
      <Stack align="center" p="md" gap="md">
        <Box
          w={240}
          h={240}
          style={{ background: "white", padding: 12, borderRadius: 8 }}
          dangerouslySetInnerHTML={{ __html: renderSVG(conf, { border: 1 }) }}
        />
        <Alert color="orange" w="100%">
          Save and apply your settings before it connects. Its private key exists only on this page: once you
          leave, a new one must be made.
        </Alert>
        <Group>
          <Button variant="default" leftSection={<IconDownload size={16} />} onClick={download}>
            Save {name || "client"}.conf
          </Button>
          <Button onClick={onDone}>Done</Button>
        </Group>
        <Text size="xs" c="dimmed">
          WireGuard apps: iOS, Android, macOS, Windows and Linux.
        </Text>
      </Stack>
    </Section>
  );
};
