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
} from "react-router";
import { useIntent } from "./data/intent";
import { IntentForm, useSaveActions } from "./form/IntentForm";
import { pages } from "./pages";
import { ProvisionButton } from "./provision/ProvisionButton";

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
  const navigate = useNavigate();
  const { pathname } = useLocation();
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
        {pages.map((page) => {
          const { id, label, icon: Icon } = page;
          const children = "children" in page ? page.children : undefined;
          return (
            <NavLink
              key={id}
              label={label}
              leftSection={<Icon size={18} stroke={1.6} />}
              active={isActive(id) && !children}
              opened={!!children && isActive(id)}
              onClick={() => navigate(`/${id}`)}
              style={{ borderRadius: 8 }}
            >
              {children?.map((child) => {
                const path = child.id ? `/${id}/${child.id}` : `/${id}`;
                return (
                  <NavLink
                    key={child.id}
                    label={child.label}
                    active={
                      child.id
                        ? isActive(`${id}/${child.id}`)
                        : pathname === `/${id}`
                    }
                    onClick={() => navigate(path)}
                    style={{ borderRadius: 8 }}
                  />
                );
              })}
            </NavLink>
          );
        })}
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
const router = createHashRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="general" replace /> },
      ...pages.map(({ id, Page }) => ({ path: `${id}/*`, element: <Page /> })),
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
