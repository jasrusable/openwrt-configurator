import { timezones } from "../../../src/intent/timezones";
import { PasswordField, SelectField, TextField } from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

const timezoneOptions = Object.keys(timezones).map((zone) => ({
  value: zone,
  label: zone.replace(/_/g, " "),
}));

export const GeneralPage = () => (
  <SettingsPage title="General" description="Your network as a whole.">
    <Section>
      <TextField name="site.name" label="Name" />
      <SelectField
        name="site.timezone"
        label="Time zone"
        options={timezoneOptions}
        searchable
      />
      <TextField
        name="site.country"
        label="Country"
        description="Two letters, like CH. Sets which Wi-Fi channels are allowed."
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
