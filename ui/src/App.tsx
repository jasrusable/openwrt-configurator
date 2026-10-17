import { Alert, AppShell, Badge, Burger, Button, Center, Divider, Group, NavLink, Paper, PasswordInput, Skeleton, Stack, Text, ThemeIcon } from "@mantine/core";
import { Hint } from "./kit/Hint";
import { useDisclosure } from "@mantine/hooks";
import { IconChevronLeft, IconSettings, IconTopologyStar3 } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { logIn, NoSettingsError, onLoginNeeded } from "./data/api";
import { prefetchApplyPlan, useFreshDevices } from "./data/devices";
import { prefetchNetworkStatus, useNetworkStatus } from "./data/status";
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
import { FirstRun } from "./backup/FirstRun";
import { useDraftValue } from "./form/draft";
import { useDraftChanged } from "./form/draft";
import { IntentForm, useSaveActions } from "./form/IntentForm";
import { ProblemCount, ProblemsButton, usePageProblems } from "./form/Problems";
import { useUpdates } from "./data/firmware";
import { UpdateDot } from "./kit/UpdateDot";
import { AppIcon, StatusDot } from "./kit/layout";
import { settingsPages, statusPages } from "./pages";
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
          <Hint label={error} width={260}>
            <Text size="sm" c="red" hiddenFrom="sm" tabIndex={0} aria-label={`Not saved: ${error}`}>
              Not saved
            </Text>
          </Hint>
        </>
      ) : (
        dirty &&
        valid && (
          <Text size="sm" c="dimmed" visibleFrom="sm">
            Unsaved changes
          </Text>
        )
      )}
      {/* On a phone, only while there is something to save: room for the rest of the header. */}
      <Button variant="subtle" color="gray" onClick={revert} disabled={!dirty || saving} visibleFrom={dirty ? undefined : "sm"}>
        Revert
      </Button>
      <Button variant={dirty ? "filled" : "default"} onClick={save} disabled={!dirty || !valid} loading={saving} visibleFrom={dirty ? undefined : "sm"}>
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

/** Beside a settings page in the sidebar: its problems' count, and System's update dot. */
const NavMarks = ({ id, problems }: { id: string; problems: number }) => {
  const updates = useUpdates();
  return (
    <Group gap={6} wrap="nowrap">
      {id === "system" && updates && <UpdateDot label={updates.text} />}
      <ProblemCount count={problems} />
    </Group>
  );
};

/**
 * Beside a status page: quiet unless something needs you. What needs
 * attention on Overview, a dot on Internet while it is down (amber on a
 * backup line), on Devices while one does not answer; who is online.
 */
const StatusMarks = ({ id }: { id: string }) => {
  const live = useNetworkStatus().data;
  if (!live) return null;
  if (id === "overview") {
    const items = (live.attention ?? []).filter((a) => a.severity !== "info");
    return items.length ? (
      <Badge size="sm" circle color={items.some((a) => a.severity === "problem") ? "red" : "orange"} variant="filled" aria-label={`${items.length} need attention`}>
        {items.length}
      </Badge>
    ) : null;
  }
  if (id === "internet" && live.internet) {
    const backup = live.connections.length > 1 && live.internet.up && !live.connections[0]?.inUse;
    return !live.internet.up ? <StatusDot color="red" /> : backup ? <StatusDot color="orange" /> : null;
  }
  if (id === "devices") return (live.deviceViews ?? []).some((d) => !d.reachable && !d.rebooting) ? <StatusDot color="red" /> : null;
  if (id === "clients") {
    const online = (live.clientList ?? []).filter((c) => c.state === "online").length;
    return (
      <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
        {online}
      </Text>
    );
  }
  return null;
};

// Where each mode was left, so going back and forth returns there (a per-viewer convenience).
const remembered = (key: string, fallback: string, prefix: (path: string) => boolean) => {
  try {
    const path = localStorage.getItem(key);
    return path && prefix(path) ? path : fallback;
  } catch {
    return fallback;
  }
};
const remember = (key: string, path: string) => {
  try {
    localStorage.setItem(key, path);
  } catch {
    // Storage blocked: each mode opens on its first page.
  }
};
const isSettings = (path: string) => path === "/settings" || path.startsWith("/settings/");

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
  const inSettings = isSettings(pathname);
  useEffect(() => remember(inSettings ? "onc-last-settings" : "onc-last-status", pathname), [pathname, inSettings]);
  const isActive = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  const go = (path: string) => {
    navigate(path);
    nav.close();
  };
  const allProblems = settingsPages.reduce((n, page) => n + problems(page.id), 0);
  const updates = useUpdates();
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
        {inSettings ? (
          <Stack gap={0}>
            <NavLink
              label="Status"
              leftSection={<IconChevronLeft size={18} />}
              className="onc-nav onc-nav-mode"
              onClick={() => go(remembered("onc-last-status", "/overview", (p) => !isSettings(p)))}
              style={{ borderRadius: 8 }}
              mb="sm"
            />
            {/* The mode's title: a quiet label, not a page. */}
            <Text size="xs" fw={600} c="dimmed" px={12} pb={6}>
              Settings
            </Text>
            {settingsPages.map(({ id, label, icon, color }) => (
              <NavLink
                key={id}
                label={label}
                leftSection={<AppIcon icon={icon} color={color} />}
                rightSection={<NavMarks id={id} problems={problems(id)} />}
                active={isActive(`/settings/${id}`)}
                // A soft fill, as macOS selects among coloured icons.
                className="onc-nav"
                onClick={() => go(`/settings/${id}`)}
                style={{ borderRadius: 8 }}
                mb={2}
              />
            ))}
          </Stack>
        ) : (
          <Stack gap={0} h="100%">
            {statusPages.map(({ id, label, icon, color }) => (
              <NavLink
                key={id}
                label={label}
                leftSection={<AppIcon icon={icon} color={color} />}
                rightSection={<StatusMarks id={id} />}
                active={isActive(`/${id}`)}
                className="onc-nav"
                onClick={() => go(`/${id}`)}
                style={{ borderRadius: 8 }}
                mb={2}
              />
            ))}
            <Divider my="sm" color="var(--onc-separator)" />
            <NavLink
              label="Settings"
              leftSection={<AppIcon icon={IconSettings} color="gray" />}
              rightSection={
                <Group gap={6} wrap="nowrap">
                  {updates && <UpdateDot label={updates.text} />}
                  <ProblemCount count={allProblems} />
                </Group>
              }
              className="onc-nav"
              onClick={() => go(remembered("onc-last-settings", "/settings/internet", isSettings))}
              style={{ borderRadius: 8 }}
            />
          </Stack>
        )}
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
        <Button variant="default" onClick={() => (window.location.hash = "/overview")}>
          Go to Overview
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
          // Status pages; Clients and Devices have one page per item beneath.
          ...statusPages.map((page) => ({ path: ["clients", "devices"].includes(page.id) ? `${page.id}/*` : page.id, element: <page.Page /> })),
          { path: "settings", element: <Navigate to="/settings/internet" replace /> },
          ...settingsPages.map((page) => ({ path: `settings/${page.id}/*`, element: <page.Page /> })),
          // Apply was a page: it is the sheet over the Overview now.
          { path: "apply", element: <Navigate to="/overview?apply" replace /> },
          // Settings were at the top before their mode: /internet/0 is a line's settings, /internet itself its status.
          ...["system", "networks", "firewall", "vpn", "dns", "hardware", "internet", "wifi"].map((id) => ({ path: `${id}/*`, element: <MovedTo base={`/settings/${id}`} /> })),
          { path: "general/*", element: <MovedTo base="/settings/system" /> },
          // The catalog was its own page, named Fixes.
          { path: "fixes", element: <Navigate to="/settings/system/patches" replace /> },
          { path: "fixes/*", element: <Navigate to="/settings/system/patches" replace /> },
          // Old addresses: General is System, SSIDs and Radios are Wi-Fi's tabs.
          { path: "ssids/*", element: <MovedTo base="/settings/wifi" /> },
          { path: "radios/*", element: <MovedTo base="/settings/wifi/radios" /> },
          // Performance was the line and the air: each has its own page now.
          { path: "performance", element: <Navigate to="/internet" replace /> },
          // Status's tabs were under the Overview: each is its own page now.
          ...["clients", "devices", "activity", "internet", "wifi"].map((tab) => ({ path: `overview/${tab}`, element: <Navigate to={`/${tab}`} replace /> })),
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
    void prefetchApplyPlan(queryClient);
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
  if (intent.isError && intent.error instanceof NoSettingsError) return <FirstRun />;
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
