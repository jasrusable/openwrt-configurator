import { countries } from "../../../src/intent/countries";
import { timezones } from "../../../src/intent/timezones";
import { PasswordField, SelectField, TextField } from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

const timezoneOptions = Object.keys(timezones).map((zone) => ({
  value: zone,
  label: zone.replace(/_/g, " "),
}));

// Names in the browser's language, from the same codes the schema accepts.
const countryName = new Intl.DisplayNames(undefined, { type: "region" });
const countryOptions = countries
  .map((code) => ({ value: code, label: countryName.of(code) ?? code }))
  .sort((a, b) => a.label.localeCompare(b.label));

export const GeneralPage = () => (
  <SettingsPage title="General" description="Your network as a whole.">
    <Section>
      <TextField name="site.name" label="Name" />
      <SelectField
        name="site.country"
        label="Country"
        description="Sets which Wi-Fi channels and power levels are allowed."
        options={countryOptions}
        searchable
      />
      <SelectField
        name="site.timezone"
        label="Time zone"
        options={timezoneOptions}
        searchable
      />
    </Section>
    <Section
      title="Administration"
      description="How this app signs in to your devices to configure them."
    >
      <TextField
        name="admin.ssh_key_path"
        label="SSH key"
        placeholder="~/.ssh/id_ed25519"
      />
      <PasswordField name="admin.password" label="Password" />
    </Section>
  </SettingsPage>
);
