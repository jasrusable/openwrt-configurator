import { countries } from "../../../src/intent/system";
import { timezones } from "../../../src/intent/system";
import { Button, Group, TextInput } from "@mantine/core";
import { useState } from "react";
import { describeKey, keyIdentity } from "../../../src/sshKeys";
import { useOwnKey } from "../data/admin";
import { useDraftList, useFieldError } from "../form/draft";
import { PasswordField, SelectField, SwitchField, TextField } from "../form/fields";
import { placeName } from "../../../src/intent/places";
import { Section, SettingRow, SettingsPage } from "../kit/layout";

export const timezoneOptions = Object.keys(timezones).map((zone) => ({
  value: zone,
  label: zone.replace(/_/g, " "),
}));

// Names in the browser's language, from the same codes the schema accepts.
const countryName = new Intl.DisplayNames(undefined, { type: "region" });
export const countryOptions = countries
  .map((code) => ({ value: code, label: countryName.of(code) ?? code }))
  .sort((a, b) => a.label.localeCompare(b.label));

/**
 * Who may log in to the devices as root: installed by every apply. This
 * app's own key is offered when it is missing, as without it password login
 * cannot be turned off.
 */
const AuthorizedKeys = () => {
  const list = useDraftList("system.ssh.authorized_keys");
  const keys = list.items;
  const own = useOwnKey().data;
  const [adding, setAdding] = useState("");
  const ownMissing = !!own && !keys.some((k) => keyIdentity(k) === keyIdentity(own));
  return (
    <Section
      title="Authorized keys"
      description="Public keys that may log in to the devices as root, installed on every device when you apply."
    >
      {keys.map((line, i) => (
        <KeyRow key={i} index={i} line={line} onRemove={() => list.remove(i)} />
      ))}
      {ownMissing && (
        <SettingRow label="This app's key" description={`${describeKey(own!).type} · ${describeKey(own!).comment || "no comment"}: not authorized yet.`}>
          <Button variant="light" size="compact-sm" onClick={() => list.add(own!)}>
            Add it
          </Button>
        </SettingRow>
      )}
      <SettingRow label="Add a key" description="Paste a public key, like ssh-ed25519 AAAA… you@computer.">
        <Group gap={6} wrap="nowrap">
          <TextInput
            value={adding}
            onChange={(e) => setAdding(e.currentTarget.value)}
            placeholder="ssh-ed25519 AAAA…"
            spellCheck={false}
            w={220}
          />
          <Button
            variant="default"
            size="sm"
            disabled={!adding.trim()}
            onClick={() => {
              list.add(adding.trim());
              setAdding("");
            }}
          >
            Add
          </Button>
        </Group>
      </SettingRow>
    </Section>
  );
};

/** One key, shown short; a key that is not one says so, at its row. */
const KeyRow = ({ index, line, onRemove }: { index: number; line: string; onRemove: () => void }) => {
  const error = useFieldError(`system.ssh.authorized_keys.${index}`);
  const { type, comment, tail } = describeKey(line);
  return (
    <SettingRow label={comment || "No comment"} description={`${type} · …${tail}`} error={error}>
      <Button variant="subtle" color="red" size="compact-sm" onClick={onRemove}>
        Remove
      </Button>
    </SettingRow>
  );
};

export const SystemPage = () => (
  <SettingsPage
    title={placeName("general")}
    description="Name, time and administration."
  >
    <Section>
      <TextField name="system.name" />
      <SelectField
        name="system.country"
        options={countryOptions}
        searchable
      />
      <SelectField
        name="system.timezone"
        options={timezoneOptions}
        searchable
      />
    </Section>
    <Section
      title="Administration"
      description="How this app signs in to your devices."
    >
      <TextField
        name="system.app_login.key"
        placeholder="~/.ssh/id_ed25519"
      />
      <PasswordField name="system.app_login.password" />
    </Section>
    <AuthorizedKeys />
    <Section>
      <SwitchField
        name="system.ssh.password_login"
      />
    </Section>
  </SettingsPage>
);
