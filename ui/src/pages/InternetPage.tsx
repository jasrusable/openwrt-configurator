import {
  NumberField,
  OptionalField,
  PasswordField,
  SwitchField,
  TextField,
  VariantField,
  When,
} from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

export const InternetPage = () => (
  <SettingsPage title="Internet" description="How your router connects.">
    <Section>
      <VariantField
        name="internet.connection"
        label="Connection"
        variants={[
          { value: "dhcp", label: "Automatic", initial: { type: "dhcp" } },
          {
            value: "pppoe",
            label: "PPPoE",
            initial: { type: "pppoe", username: "", password: "" },
          },
        ]}
      />
      <When name="internet.connection.type" is="pppoe">
        <TextField name="internet.connection.username" label="Username" />
        <PasswordField name="internet.connection.password" label="Password" />
      </When>
      <SwitchField name="internet.ipv6" label="IPv6" />
    </Section>
    <Section description="Shapes traffic to your line's speed, so calls and games stay smooth while something downloads. Set it a little below what your line really gives.">
      <OptionalField
        name="internet.speed"
        label="Smart queueing"
        initial={{ down_mbps: 100, up_mbps: 20 }}
      >
        <NumberField name="internet.speed.down_mbps" label="Download" unit="Mbit/s" min={1} />
        <NumberField name="internet.speed.up_mbps" label="Upload" unit="Mbit/s" min={1} />
      </OptionalField>
    </Section>
  </SettingsPage>
);
