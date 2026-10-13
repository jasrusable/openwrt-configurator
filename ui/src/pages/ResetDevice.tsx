// A device in Hardware whose SSH key is not the one on record: what a reset
// or a clean flash does (it makes a new key). Read it at its address to see
// the new key's fingerprint, compare it with its console, and take it back
// under its own name, its settings kept (src/discover.ts readopt).
import { Alert, Button, Group, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useInspectReset, useReadopt } from "../data/discover";
import { modelOf } from "../facts";
import { Section, SettingRow } from "../kit/layout";

/** A read that failed on the key, not on the link. */
export const keyRefused = (error: string) => /host key/i.test(error);

const dropbearKeyName = (type: string) => (type.startsWith("ecdsa") ? "ecdsa" : type.replace(/^ssh-/, ""));

export const ResetDevice = ({ name, address }: { name: string; address?: string }) => {
  const [typed, setTyped] = useState(address ?? "");
  const read = useInspectReset();
  const take = useReadopt();
  const device = read.data;
  return (
    <Section
      title="Was it reset?"
      description="Its SSH key is not the one on record, so it is not logged in to. A device reset or flashed clean makes a new key; so could another machine at its address. Read it to see the new key, compare it with its console, then take it back: its settings stay."
    >
      <SettingRow label="Its address" error={read.error ? (read.error as Error).message : undefined}>
        <Group gap={6} wrap="nowrap">
          <TextInput value={typed} onChange={(e) => setTyped(e.currentTarget.value.trim())} placeholder="10.0.0.143" w={160} />
          <Button variant="default" loading={read.isPending} disabled={!typed} onClick={() => read.mutate({ address: typed, name })}>
            Read it
          </Button>
        </Group>
      </SettingRow>
      {device && (
        <>
          <SettingRow label="Model">
            <Text size="sm" c="dimmed">{modelOf(device.schema)}</Text>
          </SettingRow>
          <SettingRow label="MAC">
            <Text size="sm" c="dimmed" ff="monospace">{device.macs.join(", ") || "—"}</Text>
          </SettingRow>
          <SettingRow
            label="New host key"
            description={
              device.hostKey
                ? `Compare it with what its console prints for: dropbearkey -y -f /etc/dropbear/dropbear_${dropbearKeyName(device.hostKey.type)}_host_key`
                : "Its key was not recorded."
            }
          >
            <Text size="sm" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
              {device.fingerprint ?? "—"}
            </Text>
          </SettingRow>
          <SettingRow label={`Take it back as ${name}`} error={take.error ? (take.error as Error).message : undefined}>
            <Button loading={take.isPending} disabled={take.isSuccess} onClick={() => take.mutate({ address: device.address, name })}>
              {take.isSuccess ? "Taken back" : "Trust this key"}
            </Button>
          </SettingRow>
          {take.isSuccess && (
            <Alert color="green">Its new key is trusted. Apply to bring its settings back, if it was reset to OpenWrt's.</Alert>
          )}
        </>
      )}
    </Section>
  );
};
