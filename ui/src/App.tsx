import {
  Alert,
  AppShell,
  Button,
  Center,
  Group,
  Loader,
  NavLink,
  Text,
  Title,
} from "@mantine/core";
import { useIntent } from "./data/intent";
import { IntentForm, useSaveActions } from "./form/IntentForm";
import { useHashRoute } from "./kit/useHashRoute";
import { PageId, pages } from "./pages";

const SaveBar = () => {
  const { save, revert, dirty, valid, saving } = useSaveActions();
  return (
    <Group gap="xs">
      {dirty && (
        <Text size="sm" c="dimmed">
          {valid ? "Unsaved changes" : "Some settings need fixing"}
        </Text>
      )}
      <Button variant="default" onClick={revert} disabled={!dirty || saving}>
        Revert
      </Button>
      <Button onClick={save} disabled={!dirty || !valid} loading={saving}>
        Save
      </Button>
    </Group>
  );
};

const Shell = () => {
  const [route, navigate] = useHashRoute(
    pages.map((page) => page.id),
    "general" as PageId
  );
  const { Page } = pages.find((page) => page.id === route)!;
  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 240, breakpoint: "sm" }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
          <Title order={4}>Network</Title>
          <SaveBar />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        {pages.map(({ id, label, icon: Icon }) => (
          <NavLink
            key={id}
            label={label}
            leftSection={<Icon size={18} stroke={1.6} />}
            active={id === route}
            onClick={() => navigate(id)}
            style={{ borderRadius: 8 }}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main bg="var(--mantine-color-gray-0)">
        <Page />
      </AppShell.Main>
    </AppShell>
  );
};

export const App = () => {
  const intent = useIntent();
  if (intent.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (intent.isError) {
    return (
      <Center h="100vh">
        <Alert color="red" title="Could not load your network">
          {intent.error.message}
        </Alert>
      </Center>
    );
  }
  return (
    // Keyed by the saved file, so a save or a reload restarts the form from it.
    <IntentForm key={JSON.stringify(intent.data)} intent={intent.data}>
      <Shell />
    </IntentForm>
  );
};
