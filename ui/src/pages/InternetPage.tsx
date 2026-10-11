import { netmask } from "../../../src/intent/schema";
import {
  NumberField,
  OptionalField,
  PasswordField,
  SelectField,
  SwitchField,
  TagsField,
  TextField,
  VariantField,
  When,
} from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

const address = /[\d.]/;

const masks = Array.from({ length: 23 }, (_, i) => 30 - i).map((length) => ({
  value: length,
  label: `${netmask(length)} (/${length})`,
}));

const prefixes = [
  { value: "auto", label: "Automatic" },
  { value: "48", label: "/48 · 65,536 networks" },
  { value: "56", label: "/56 · 256 networks" },
  { value: "60", label: "/60 · 16 networks" },
  { value: "64", label: "/64 · 1 network" },
] as const;

const lines = [
  { value: "fibre", label: "Fibre or Ethernet" },
  { value: "cable", label: "Cable" },
  { value: "vdsl", label: "VDSL" },
  { value: "adsl", label: "ADSL" },
] as const;

export const InternetPage = () => (
  <SettingsPage title="Internet" description="How your router connects.">
    <Section>
      <VariantField
        name="internet.connection"
        label="Connection"
        variants={[
          { value: "dhcp", label: "DHCP", initial: { type: "dhcp" } },
          {
            value: "pppoe",
            label: "PPPoE",
            initial: { type: "pppoe", username: "", password: "" },
          },
          {
            value: "static",
            label: "Static IP",
            initial: { type: "static", address: "", prefix_length: 24, gateway: "" },
          },
        ]}
      />
      <When name="internet.connection.type" is="pppoe">
        <TextField name="internet.connection.username" label="Username" />
        <PasswordField name="internet.connection.password" label="Password" />
      </When>
      <When name="internet.connection.type" is="static">
        <TextField
          name="internet.connection.address"
          label="IP address"
          placeholder="203.0.113.10"
          chars={address}
        />
        <SelectField
          name="internet.connection.prefix_length"
          label="Subnet mask"
          options={masks}
        />
        <TextField
          name="internet.connection.gateway"
          label="Gateway"
          placeholder="203.0.113.1"
          chars={address}
        />
        <TagsField
          name="internet.connection.dns"
          label="DNS servers"
          description="From your provider. Not needed with encrypted DNS."
          placeholder="Add a server"
        />
      </When>
      <OptionalField
        name="internet.vlan"
        label="VLAN tag"
        description="Only if your provider says the line needs one."
        initial={10}
      >
        <NumberField name="internet.vlan" label="VLAN ID" min={1} max={4094} integer />
      </OptionalField>
    </Section>
    <Section>
      <SwitchField name="internet.ipv6" label="IPv6" />
      <When name="internet.ipv6" is={true}>
        <SelectField
          name="internet.ipv6_prefix"
          label="Prefix size"
          description="How much address space to ask your provider for. Each network with IPv6 needs a /64."
          options={[...prefixes]}
        />
      </When>
    </Section>
    <Section description="Only devices on the main network, only for themselves, and only ports above 1024. Guest and other networks cannot use it.">
      <SwitchField
        name="internet.upnp"
        label="UPnP and NAT-PMP"
        description="Lets games and apps open the ports they need, without port forwards."
      />
    </Section>
    <Section description="Shapes traffic to your line's speed, so calls and games stay smooth while something downloads. Set it a little below what your line really gives.">
      <OptionalField
        name="internet.speed"
        label="Smart queueing"
        initial={{ down_mbps: 100, up_mbps: 20, line: "fibre" }}
      >
        <NumberField name="internet.speed.down_mbps" label="Download" unit="Mbit/s" min={1} />
        <NumberField name="internet.speed.up_mbps" label="Upload" unit="Mbit/s" min={1} />
        <SelectField
          name="internet.speed.line"
          label="Line type"
          description="What the line adds to every packet, so queueing counts it."
          options={[...lines]}
        />
      </OptionalField>
    </Section>
  </SettingsPage>
);
