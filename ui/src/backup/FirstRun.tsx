// No settings saved here yet (a new install, or a router after a factory
// reset): restore a backup, or start a new network from its name, country
// and time zone. Either writes the settings file, and the app opens on it.
import { Alert, Button, Card, Center, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { where } from "../../../src/intent/places";
import { restoreBackup } from "../data/api";
import { intentKey } from "../data/intent";
import { countryOptions, timezoneOptions } from "../pages/SystemPage";
import { ReplaceFlow } from "./ReplaceFlow";

/** The browser's own zone and region, when the lists hold them: a likely start. */
const guess = () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const region = navigator.language.split("-")[1]?.toUpperCase();
  return {
    timezone: timezoneOptions.some((o) => o.value === zone) ? zone : null,
    country: countryOptions.some((o) => o.value === region) ? region! : null,
  };
};

const StartNew = () => {
  const queryClient = useQueryClient();
  const [name, setName] = useState("Home");
  const [{ country, timezone }, setPlace] = useState(guess);
  const start = useMutation({
    mutationFn: () => restoreBackup({ from: "new", choices: { name: name.trim(), country: country!, timezone: timezone! } }),
    onSuccess: (intent) => queryClient.setQueryData(intentKey, intent),
  });
  return (
    <Stack gap="sm">
      <TextInput label="Network name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <Select label="Country" data={countryOptions} value={country} onChange={(v) => setPlace((p) => ({ ...p, country: v }))} searchable />
      <Select label="Time zone" data={timezoneOptions} value={timezone} onChange={(v) => setPlace((p) => ({ ...p, timezone: v }))} searchable />
      <Text size="xs" c="dimmed">
        The router starts at 192.168.1.1, where a new OpenWrt router answers. Add the rest under Hardware.
      </Text>
      {start.isError && <Alert color="red">{start.error.message}</Alert>}
      <Button disabled={!name.trim() || !country || !timezone} loading={start.isPending} onClick={() => start.mutate()}>
        Start new
      </Button>
    </Stack>
  );
};

export const FirstRun = () => {
  const [restoring, setRestoring] = useState(false);
  return (
    <Center mih="100vh" p="md">
      <Stack gap="lg" w={420} maw="100%">
        <Stack gap={4}>
          <Title order={2}>Set up your network</Title>
          <Text c="dimmed">No settings are saved here yet.</Text>
        </Stack>
        <Card withBorder radius="md" padding="lg">
          <Stack gap="sm">
            <Text fw={600}>Restore from a backup</Text>
            <Text size="sm" c="dimmed">
              A settings file downloaded from {where("backup")}.
            </Text>
            <Button variant="light" onClick={() => setRestoring(true)}>
              Restore…
            </Button>
          </Stack>
        </Card>
        <Card withBorder radius="md" padding="lg">
          <Stack gap="sm">
            <Text fw={600}>Start a new network</Text>
            <StartNew />
          </Stack>
        </Card>
      </Stack>
      {restoring && <ReplaceFlow kind="file" opened firstRun onClose={() => setRestoring(false)} onDone={() => undefined} />}
    </Center>
  );
};
