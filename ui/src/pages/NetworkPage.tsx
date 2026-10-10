import { DurationField, NumberField, SubnetField, SwitchField, TextField, Value } from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

export const NetworkPage = () => (
  <SettingsPage title="Network" description="Your home network.">
    <Section>
      <SubnetField
        name="network.subnet"
        label="Addresses"
        description={
          <>
            The router is{" "}
            <Value
              name="network.subnet"
              format={(subnet: string) => subnet?.replace(/\.0\/24$/, ".1")}
            />
          </>
        }
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
      <DurationField name="network.dhcp.lease" label="Lease time" />
    </Section>
  </SettingsPage>
);
