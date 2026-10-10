import { NumberField, SwitchField, TextField } from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

export const NetworkPage = () => (
  <SettingsPage title="Network" description="Your home network.">
    <Section>
      <TextField
        name="network.subnet"
        label="Addresses"
        description="The router takes the first one."
        placeholder="10.0.0.0/24"
      />
      <TextField
        name="network.domain"
        label="Local domain"
        description="Devices are reachable as name.domain."
      />
      <SwitchField name="network.ipv6" label="IPv6" />
    </Section>
    <Section title="Handing out addresses">
      <NumberField
        name="network.dhcp.size"
        label="Addresses for devices"
        min={1}
        max={253}
      />
      <TextField
        name="network.dhcp.lease"
        label="Lease time"
        description="Like 12h, 30m or 7d."
      />
    </Section>
  </SettingsPage>
);
