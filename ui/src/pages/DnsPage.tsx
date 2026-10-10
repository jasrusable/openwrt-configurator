import { SelectField, TextField } from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

export const DnsPage = () => (
  <SettingsPage title="DNS" description="How names like example.com are looked up.">
    <Section>
      <TextField
        name="dns.local_domain"
        label="Local domain"
        description="Devices are reachable as name.domain."
      />
    </Section>
    <Section description="Encrypts lookups so your provider cannot see or change them.">
      <SelectField
        name="dns.over_https"
        label="Encrypted DNS"
        emptyLabel="Off (use your provider's)"
        options={[
          { value: "cloudflare", label: "Cloudflare" },
          { value: "google", label: "Google" },
          { value: "quad9", label: "Quad9" },
        ]}
      />
    </Section>
  </SettingsPage>
);
