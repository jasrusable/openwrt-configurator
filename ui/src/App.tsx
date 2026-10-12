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
import {
  createHashRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useNavigate,
  useParams,
  useRouteError,
} from "react-router";
import { useIntent } from "./data/intent";
import { IntentForm, useSaveActions } from "./form/IntentForm";
import { ProblemCount, ProblemsButton, usePageProblems } from "./form/Problems";
import { pages } from "./pages";
import { ProvisionButton } from "./provision/ProvisionButton";

const SaveBar = () => {
  const { save, revert, dirty, valid, saving } = useSaveActions();
  return (
    <Group gap="xs">
      <ProblemsButton />
      {dirty && valid && (
        <Text size="sm" c="dimmed">
          Unsaved changes
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
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const problems = usePageProblems();
  const isActive = (id: string) =>
    pathname === `/${id}` || pathname.startsWith(`/${id}/`);
  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 240, breakpoint: "sm" }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
          <Title order={4}>Network</Title>
          <Group gap="sm">
            <SaveBar />
            <ProvisionButton />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        {pages.map(({ id, label, icon: Icon }) => (
          <NavLink
            key={id}
            label={label}
            leftSection={<Icon size={18} stroke={1.6} />}
            rightSection={<ProblemCount count={problems(id)} />}
            active={isActive(id)}
            onClick={() => navigate(`/${id}`)}
            style={{ borderRadius: 8 }}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main bg="var(--mantine-color-gray-0)">
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
};

// A hash router: the URL's path after # is the page, so the same build works
// wherever it is served from, with no server-side routes. `/*` lets a page
// have its own nested pages (one Wi-Fi network, one device).
/** A page that failed to render: say so, keep the rest of the app usable. */
const PageError = () => {
  const error = useRouteError();
  return (
    <Center h="100vh" p="md">
      <Alert color="red" title="This page hit a problem" maw={560}>
        <Text size="sm" mb="md">
          {(error as Error)?.message ?? String(error)}
        </Text>
        <Button variant="default" onClick={() => (window.location.hash = "/general")}>
          Go to General
        </Button>
      </Alert>
    </Center>
  );
};

/** An old address: the same page under its new one. */
const MovedTo = ({ base }: { base: string }) => {
  const rest = useParams()["*"];
  return <Navigate to={rest ? `${base}/${rest}` : base} replace />;
};

const router = createHashRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <PageError />,
    children: [
      { index: true, element: <Navigate to="general" replace /> },
      ...pages.map((page) => ({ path: `${page.id}/*`, element: <page.Page /> })),
      // Where SSIDs and Radios were before they were Wi-Fi's tabs.
      { path: "ssids/*", element: <MovedTo base="/wifi" /> },
      { path: "radios/*", element: <MovedTo base="/wifi/radios" /> },
      { path: "*", element: <Navigate to="general" replace /> },
    ],
  },
]);

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
      <RouterProvider router={router} />
    </IntentForm>
  );
};
