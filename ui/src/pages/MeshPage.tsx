// Wi-Fi › Mesh: access points linked over Wi-Fi (802.11s with batman-adv),
// so one needs no cable. Experimental: the compiler follows a setup run at
// another site, but this app has not yet run it on real hardware.
import { Alert, Text } from "@mantine/core";
import { meshChannels } from "../../../src/intent/radios";
import { where } from "../../../src/intent/places";
import { Intent } from "../../../src/intent/schema";
import { useDevices } from "../data/devices";
import { useDraftValue } from "../form/draft";
import { PasswordField, SegmentedField, SelectField, SwitchField } from "../form/fields";
import { Experimental, Section, SettingRow, SettingsPage } from "../kit/layout";
import { bandLabels } from "../../../src/intent/labels";
import { meshAbility } from "../facts";

/** Each device, and how it takes part: by cable or over the mesh, if its radio can. */
const Nodes = () => {
  const intent: Intent = useDraftValue();
  const facts = useDevices().data?.facts;
  const { band } = intent.wifi.mesh;
  const rows = intent.hardware.map((device) => {
    const ability = meshAbility(facts?.[device.name]?.schema, band);
    const cabled = device.role === "router" || device.uplink !== "mesh";
    const how = {
      unknown: "Not read yet",
      "no-radio": `No ${bandLabels[band]} radio: not in the mesh`,
      cannot: "Its radio cannot mesh",
      can: cabled ? "Cabled: links the mesh to your network" : "Over the mesh",
    }[ability];
    return { device, known: ability !== "unknown", node: ability === "can", cabled, how };
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
  const { enabled, band } = intent.wifi.mesh;
  return (
    <SettingsPage
      title={<Experimental>Mesh</Experimental>}
      description="Access points link over Wi-Fi, so they need only power."
    >
      <Section>
        <SwitchField name="wifi.mesh.enabled" />
      </Section>
      {enabled && (
        <>
          <Section
            description={
              intent.wifi.mesh.band_reserved
                ? "Devices use your other bands; the mesh has this one to itself."
                : "The mesh shares this band's radio with devices: Wi-Fi in it is slower."
            }
          >
            <SegmentedField
              name="wifi.mesh.band"
              options={(["5g", "2g", "6g"] as const).map((b) => ({ value: b, label: bandLabels[b] }))}
            />
            <SelectField
              name="wifi.mesh.channel"
              options={meshChannels[band].map((channel) => ({ value: channel, label: String(channel) }))}
            />
            <SwitchField name="wifi.mesh.band_reserved" />
            <SwitchField name="wifi.mesh.over_cable" />
            <SwitchField name="wifi.mesh.large_frames" />
            <PasswordField name="wifi.mesh.key" />
          </Section>
          <Nodes />
        </>
      )}
    </SettingsPage>
  );
};
