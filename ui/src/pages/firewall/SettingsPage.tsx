import { builtinRules, BuiltinRule } from "../../../../src/intent/firewall";
import { policyOptions } from "../../firewall/zones";
import { ListToggleField, SegmentedField, SwitchField } from "../../form/fields";
import { Section, SettingsPage } from "../../kit/layout";

export const FirewallSettingsPage = () => (
  <SettingsPage title="Firewall settings" description="Defaults and OpenWrt's built-in WAN rules." wide>
    <Section title="Defaults" description="For traffic no zone decides.">
      <SegmentedField name="firewall.defaults.input" label="Input" options={policyOptions} />
      <SegmentedField name="firewall.defaults.output" label="Output" options={policyOptions} />
      <SegmentedField name="firewall.defaults.forward" label="Forward" options={policyOptions} />
      <SwitchField name="firewall.defaults.syn_flood_protection" label="SYN flood protection" />
      <SwitchField name="firewall.defaults.drop_invalid" label="Drop invalid packets" />
    </Section>
    <Section title="Built-in rules" description="OpenWrt's stock rules for traffic from WAN. Turn off only what you know you do not need.">
      {(Object.keys(builtinRules) as BuiltinRule[]).map((id) => (
        <ListToggleField
          key={id}
          name="firewall.builtin_rules_off"
          value={id}
          inverted
          label={builtinRules[id].label}
          description={builtinRules[id].description}
        />
      ))}
    </Section>
  </SettingsPage>
);
