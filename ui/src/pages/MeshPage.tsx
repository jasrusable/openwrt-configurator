// Wi-Fi › Mesh: access points linked over Wi-Fi (802.11s with batman-adv),
// so one needs no cable. Experimental: the compiler follows a setup run at
// another site, but this app has not yet run it on real hardware.
import { Alert, Group, Text } from "@mantine/core";
import { meshChannels } from "../../../src/intent/choices";
import { where } from "../../../src/intent/places";
import { Intent } from "../../../src/intent/schema";
import { useDevices } from "../data/devices";
import { useDraftValue } from "../form/draft";
import { PasswordField, SegmentedField, SelectField, SwitchField } from "../form/fields";
import { ExperimentalBadge, Section, SettingRow, SettingsPage } from "../kit/layout";

const bandLabels = { "2g": "2.4 GHz", "5g": "5 GHz", "6g": "6 GHz" } as const;

/** Each device, and how it takes part: by cable or over the mesh, if its radio can. */
const Nodes = () => {
  const intent: Intent = useDraftValue();
  const facts = useDevices().data?.facts;
  const { band } = intent.mesh;
  const rows = intent.hardware.map((device) => {
    const radios = facts?.[device.name]?.schema.radios?.filter((r) => r.band === band);
    const known = facts?.[device.name] !== undefined;
    const canMesh = radios?.length ? radios.some((r) => r.mesh !== false) : false;
    const cabled = device.role === "router" || device.uplink !== "mesh";
    const how = !known
      ? "Not read yet"
      : !radios?.length
        ? `No ${bandLabels[band]} radio: not in the mesh`
        : !canMesh
          ? "Its radio cannot mesh"
          : cabled
            ? "Cabled: links the mesh to your network"
            : "Over the mesh";
    return { device, known, node: known && !!radios?.length && canMesh, cabled, how };
  });
  // What links the mesh to the rest: a cabled node. Only said once every device is known.
  const unlinked = rows.every((r) => r.known) && !rows.some((r) => r.node && r.cabled);
  return (
    <>
      {unlinked && (
        <Alert color="orange" title="Nothing links the mesh to your network">
          No cabled access point (or the router) has a {bandLabels[band]} radio that can mesh. Cable one, or choose
          another band.
        </Alert>
      )}
      <Section title="Devices" description={`Each access point's connection is on its page (${where("hardware")}).`}>
        {rows.map(({ device, how }) => (
          <SettingRow key={device.name} label={device.name}>
            <Text size="sm" c="dimmed" ta="right">
              {how}
            </Text>
          </SettingRow>
        ))}
      </Section>
    </>
  );
};

export const MeshPage = () => {
  const intent: Intent = useDraftValue();
  const { enabled, band } = intent.mesh;
  return (
    <SettingsPage
      title={
        <Group gap={10}>
          Mesh
          <ExperimentalBadge />
        </Group>
      }
      description="Access points link over Wi-Fi, so they need only power."
    >
      <Section>
        <SwitchField name="mesh.enabled" label="Mesh" />
      </Section>
      {enabled && (
        <>
          <Section
            description={
              intent.mesh.dedicated
                ? "Devices use your other bands; the mesh has this one to itself."
                : "The mesh shares this band's radio with devices: Wi-Fi in it is slower."
            }
          >
            <SegmentedField
              name="mesh.band"
              label="Band"
              options={[
                { value: "5g", label: "5 GHz" },
                { value: "2g", label: "2.4 GHz" },
                { value: "6g", label: "6 GHz" },
              ]}
            />
            <SelectField
              name="mesh.channel"
              label="Channel"
              options={meshChannels[band].map((channel) => ({ value: channel, label: String(channel) }))}
            />
            <SwitchField name="mesh.dedicated" label="Only for the mesh" />
            <SwitchField name="mesh.wired" label="Also over cables" />
            <SwitchField name="mesh.jumbo" label="Larger frames over cable" />
            <PasswordField name="mesh.key" label="Mesh key" />
          </Section>
          <Nodes />
        </>
      )}
    </SettingsPage>
  );
};
