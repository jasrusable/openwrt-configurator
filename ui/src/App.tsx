import {
  Alert,
  AppShell,
  Burger,
  Button,
  Center,
  Group,
  NavLink,
  Paper,
  PasswordInput,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconTopologyStar3 } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { logIn, onLoginNeeded } from "./data/api";
import { prefetchApplyDiff, useFreshDevices } from "./data/devices";
import { prefetchNetworkStatus } from "./data/status";
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
import { ApplyModal } from "./provision/ApplyModal";
import { ProvisionButton } from "./provision/ProvisionButton";

/**
 * Revert and Save, always there, greyed out with nothing to save (as LuCI's
 * Save and Reset); Save the one primary action while there are edits. A save
 * that fails says why beside them, no toast.
 */
const SaveBar = () => {
  const { save, revert, dirty, valid, saving, error } = useSaveActions();
  return (
    <Group gap="xs" wrap="nowrap">
      <ProblemsButton />
      {error ? (
        <>
          <Text size="sm" c="red" visibleFrom="sm" maw={260} truncate title={error}>
            Not saved: {error}
          </Text>
          {/* On a phone, too little room for the reason: the word, the reason on a tap. */}
          <Tooltip label={error} multiline w={260} withArrow events={{ hover: true, focus: true, touch: true }}>
            <Text size="sm" c="red" hiddenFrom="sm" tabIndex={0} aria-label={`Not saved: ${error}`}>
              Not saved
            </Text>
          </Tooltip>
        </>
      ) : (
        dirty &&
        valid && (
          <Text size="sm" c="dimmed" visibleFrom="sm">
            Unsaved changes
          </Text>
        )
      )}
      <Button variant="subtle" color="gray" onClick={revert} disabled={!dirty || saving}>
        Revert
      </Button>
      <Button variant={dirty ? "filled" : "default"} onClick={save} disabled={!dirty || !valid} loading={saving}>
        Save
      </Button>
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
  const site: string = useDraftValue("system.name") || "Network";
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
      <ApplyModal />
    </AppShell>
  );
};

// A hash router: the URL's path after # is the page, so the same build works
// wherever it is served from, with no server-side routes. `/*` lets a page
// have its own nested pages (one Wi-Fi network, one device).
/**
 * A page that failed to render: say so in its place, the sidebar and Save
 * still there (edits are kept in the draft); or, the shell itself, alone.
 */
const PageError = ({ inShell = false }: { inShell?: boolean }) => {
  const error = useRouteError();
  return (
    <Center h={inShell ? undefined : "100vh"} p="md">
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
      {
        // A page's failure stays in the page.
        errorElement: <PageError inShell />,
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          ...pages.map((page) => ({ path: `${page.id}/*`, element: <page.Page /> })),
          // Apply was a page: it is the sheet over the Overview now.
          { path: "apply", element: <Navigate to="/overview?apply" replace /> },
          { path: "general/*", element: <MovedTo base="/system" /> },
          // Old addresses: General is System, SSIDs and Radios are Wi-Fi's tabs.
          { path: "ssids/*", element: <MovedTo base="/wifi" /> },
          { path: "radios/*", element: <MovedTo base="/wifi/radios" /> },
          // Status's tabs were under the Overview: each is its own page now.
          ...["clients", "devices", "activity"].map((tab) => ({ path: `overview/${tab}`, element: <Navigate to={`/${tab}`} replace /> })),
          ...["internet", "wifi"].map((tab) => ({ path: `overview/${tab}`, element: <Navigate to="/performance" replace /> })),
          { path: "*", element: <Navigate to="overview" replace /> },
        ],
      },
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

/** The router's root password, when the app runs there (src/server/auth.ts). */
const LoginPage = ({ onDone }: { onDone: () => void }) => {
  const [password, setPassword] = useState("");
  // Why not, in the server's words: wrong, no root password yet, too many tries, or not reached.
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const why = await logIn(password);
    setBusy(false);
    if (why) setRefused(why);
    else onDone();
  };
  return (
    <Center h="100vh" bg="var(--onc-page)">
      <Paper className="onc-card" p="xl" w={340}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Stack gap="md">
            <Group gap={10}>
              <AppIcon icon={IconTopologyStar3} color="indigo" />
              <Text fw={600}>Your network</Text>
            </Group>
            <PasswordInput
              label="Router password"
              description="The router's root password, as for LuCI."
              value={password}
              onChange={(e) => {
                setPassword(e.currentTarget.value);
                setRefused(undefined);
              }}
              error={refused}
              autoFocus
            />
            <Button type="submit" loading={busy} disabled={!password}>
              Log in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
};

/**
 * As the app opens, what the pages that read devices will show is read in
 * the background: stale facts, the network's status (once, not polled), and
 * what an apply would change. The app being open is the viewer they wait for.
 */
const Warmup = () => {
  const queryClient = useQueryClient();
  useFreshDevices();
  useEffect(() => {
    void prefetchNetworkStatus(queryClient);
    void prefetchApplyDiff(queryClient);
  }, [queryClient]);
  return null;
};

export const App = () => {
  const queryClient = useQueryClient();
  const [loggedOut, setLoggedOut] = useState(false);
  useEffect(
    () =>
      onLoginNeeded(() => {
        // Logged out: nothing of the network stays, in memory either.
        queryClient.clear();
        setLoggedOut(true);
      }),
    [queryClient]
  );
  const intent = useIntent();
  if (loggedOut) {
    return (
      <LoginPage
        onDone={() => {
          setLoggedOut(false);
          void queryClient.resetQueries();
        }}
      />
    );
  }
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
    <>
      {/* Once per load, outside the form. */}
      <Warmup />
      <IntentForm intent={intent.data}>
        <RouterProvider router={router} />
      </IntentForm>
    </>
  );
};
