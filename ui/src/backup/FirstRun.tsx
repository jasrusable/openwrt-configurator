// No settings saved here yet (a new install, or a router after a factory
// reset), or saved settings that do not read (not JSON, from a newer app,
// holding `$secret` refs): restore a backup, or start a new network from its
// name, country, time zone and root's password. Either writes the settings file (one that did
// not read kept beside it), and the app opens on it.
import { Alert, Button, Card, Center, PasswordInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { where } from "../../../src/intent/places";
import { downloadBackup, RestoreError, restoreBackup } from "../data/api";
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

/** Where the review puts root's password when it is missing or will not do. */
const passwordPath = "system.app_login.password";

/** `overNothing`: no file is saved, so the write names that ("") and a second page's is refused. */
const StartNew = ({ overNothing }: { overNothing: boolean }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState("Home");
  const [password, setPassword] = useState("");
  const [{ country, timezone }, setPlace] = useState(guess);
  const start = useMutation({
    mutationFn: () =>
      restoreBackup({ from: "new", choices: { name: name.trim(), country: country!, timezone: timezone!, password } }, overNothing ? "" : undefined),
    onSuccess: (intent) => queryClient.setQueryData(intentKey, intent),
  });
  const issues = start.error instanceof RestoreError ? start.error.issues : [];
  const passwordIssue = issues.find((issue) => issue.path === passwordPath)?.message;
  return (
    <Stack gap="sm">
      <TextInput label="Network name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <Select label="Country" data={countryOptions} value={country} onChange={(v) => setPlace((p) => ({ ...p, country: v }))} searchable />
      <Select label="Time zone" data={timezoneOptions} value={timezone} onChange={(v) => setPlace((p) => ({ ...p, timezone: v }))} searchable />
      <PasswordInput
        label="Root password"
        description="Set on every device as it is applied: for this app, LuCI and SSH. Without one a device lets anyone log in."
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        error={passwordIssue}
        autoComplete="new-password"
      />
      <Text size="xs" c="dimmed">
        The router starts at 192.168.1.1, where a new OpenWrt router answers. Add the rest under Hardware.
      </Text>
      {start.isError && (
        <Alert color="red">
          <Stack gap={4}>
            <Text size="sm">{start.error.message}</Text>
            {issues
              .filter((issue) => issue.path !== passwordPath)
              .map((issue) => (
                <Text key={`${issue.path}:${issue.message}`} size="sm">
                  {issue.path ? `${issue.path}: ` : ""}
                  {issue.message}
                </Text>
              ))}
          </Stack>
        </Alert>
      )}
      <Button disabled={!name.trim() || !country || !timezone || !password} loading={start.isPending} onClick={() => start.mutate()}>
        Start new
      </Button>
    </Stack>
  );
};

/** The saved file as stored, to keep before replacing one that does not read. */
const DownloadSaved = () => {
  const download = useMutation({ mutationFn: downloadBackup });
  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="sm">
        <Text fw={600}>Download the saved file</Text>
        <Text size="sm" c="dimmed">
          As stored, to fix by hand or keep. Passwords and Wi-Fi keys in it are plain text.
        </Text>
        {download.isError && <Alert color="red">{download.error.message}</Alert>}
        <Button variant="light" loading={download.isPending} onClick={() => download.mutate()}>
          Download
        </Button>
      </Stack>
    </Card>
  );
};

/** `unreadable`: why the saved settings do not read; else none are saved. */
export const FirstRun = ({ unreadable }: { unreadable?: string }) => {
  const [restoring, setRestoring] = useState(false);
  return (
    <Center mih="100vh" p="md">
      <Stack gap="lg" w={420} maw="100%">
        <Stack gap={4}>
          <Title order={2}>{unreadable ? "Your settings do not read" : "Set up your network"}</Title>
          {unreadable ? (
            <>
              <Alert color="red">{unreadable}</Alert>
              <Text size="sm" c="dimmed">
                Restore a backup or start again: the file is kept beside it, as a .bak.
              </Text>
            </>
          ) : (
            <Text c="dimmed">No settings are saved here yet.</Text>
          )}
        </Stack>
        {unreadable && <DownloadSaved />}
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
            <StartNew overNothing={!unreadable} />
          </Stack>
        </Card>
      </Stack>
      {restoring && <ReplaceFlow kind="file" opened firstRun onClose={() => setRestoring(false)} onDone={() => undefined} />}
    </Center>
  );
};
