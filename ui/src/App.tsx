import {
  Alert,
  AppShell,
  Burger,
  Button,
  Center,
  Group,
  NavLink,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconTopologyStar3 } from "@tabler/icons-react";
import { useEffect } from "react";
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
import { useDraftValue } from "./form/draft";
import { IntentForm, useDraftChanged, useSaveActions } from "./form/IntentForm";
import { ProblemCount, ProblemsButton, usePageProblems } from "./form/Problems";
import { AppIcon } from "./kit/layout";
import { groups, pages } from "./pages";
import { ApplyPage } from "./provision/ApplyPage";
import { ProvisionButton } from "./provision/ProvisionButton";

/** Unsaved edits: Revert and Save, Save the one primary action meanwhile. */
const SaveBar = () => {
  const { save, revert, dirty, valid, saving } = useSaveActions();
  return (
    <Group gap="xs" wrap="nowrap">
      <ProblemsButton />
      {dirty && (
        <>
          {valid && (
            <Text size="sm" c="dimmed" visibleFrom="sm">
              Unsaved changes
            </Text>
          )}
          <Button variant="subtle" color="gray" onClick={revert} disabled={saving}>
            Revert
          </Button>
          <Button onClick={save} disabled={!valid} loading={saving}>
            Save
          </Button>
        </>
      )}
    </Group>
  );
};

/** The app's mark: a network of linked nodes, in the system blue. */
const Mark = () => (
  <ThemeIcon size={28} radius={8} variant="filled" aria-hidden>
    <IconTopologyStar3 size={18} stroke={1.8} />
  </ThemeIcon>
);

const Shell = () => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const problems = usePageProblems();
  const [navOpen, nav] = useDisclosure(false);
  const site: string = useDraftValue("site.name") || "Network";
  const dirty = useDraftChanged();
  useEffect(() => {
    document.title = site;
  }, [site]);
  const isActive = (id: string) => pathname === `/${id}` || pathname.startsWith(`/${id}/`);
  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 232, breakpoint: "sm", collapsed: { mobile: !navOpen } }}
      padding="md"
    >
      <AppShell.Header px="md" className="onc-chrome">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger opened={navOpen} onClick={nav.toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <Mark />
            <Text fw={600} size="md" truncate>
              {site}
            </Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <SaveBar />
            {/* While there are edits, Save leads; Apply waits for them. */}
            <ProvisionButton quiet={dirty} />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm" className="onc-chrome">
        {groups.map((group) => (
          <Stack key={group.id} gap={0} mb="md">
            {/* A group's title: a quiet label, not a page. */}
            <Text size="xs" fw={600} c="dimmed" px={12} pb={6}>
              {group.label}
            </Text>
            {pages
              .filter((page) => page.group === group.id)
              .map(({ id, label, icon, color }) => (
                <NavLink
                  key={id}
                  label={label}
                  leftSection={<AppIcon icon={icon} color={color} />}
                  rightSection={<ProblemCount count={problems(id)} />}
                  active={isActive(id)}
                  // A soft fill, as macOS selects among coloured icons.
                  className="onc-nav"
                  onClick={() => {
                    navigate(`/${id}`);
                    nav.close();
                  }}
                  style={{ borderRadius: 8 }}
                  mb={2}
                />
              ))}
          </Stack>
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
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
        <Button variant="default" onClick={() => (window.location.hash = "/system")}>
          Go to System
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
      { index: true, element: <Navigate to="overview" replace /> },
      ...pages.map((page) => ({ path: `${page.id}/*`, element: <page.Page /> })),
      { path: "apply", element: <ApplyPage /> },
      { path: "general/*", element: <MovedTo base="/system" /> },
      // Old addresses: General is System, SSIDs and Radios are Wi-Fi's tabs.
      { path: "ssids/*", element: <MovedTo base="/wifi" /> },
      { path: "radios/*", element: <MovedTo base="/wifi/radios" /> },
      { path: "*", element: <Navigate to="overview" replace /> },
    ],
  },
]);

/** While the file loads: the shape of the app, not a spinner. */
const Loading = () => (
  <AppShell header={{ height: 56 }} navbar={{ width: 232, breakpoint: "sm" }} padding="md">
    <AppShell.Header px="md" className="onc-chrome">
      <Group h="100%" gap={10}>
        <Skeleton h={28} w={28} radius={8} />
        <Skeleton h={14} w={120} />
      </Group>
    </AppShell.Header>
    <AppShell.Navbar p="sm" className="onc-chrome">
      <Stack gap={14} p={8}>
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} h={14} w={`${60 + ((i * 17) % 30)}%`} />
        ))}
      </Stack>
    </AppShell.Navbar>
    <AppShell.Main>
      <Stack gap="xl" maw={760} mx="auto" py="lg" px="md">
        <Skeleton h={26} w={180} />
        <Skeleton h={160} radius={12} />
        <Skeleton h={110} radius={12} />
      </Stack>
    </AppShell.Main>
  </AppShell>
);

export const App = () => {
  const intent = useIntent();
  if (intent.isPending) return <Loading />;
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
