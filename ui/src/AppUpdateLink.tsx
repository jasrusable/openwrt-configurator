// "Update" in the sidebar, where this app runs on a router and a newer version
// is out (src/appUpdate.ts, checked daily by the collector): one click
// installs it, and the page reloads into it once it answers. Nothing changes
// on the devices: what the new version writes differently waits for an apply.
import { Alert, Anchor, Button, Group, Loader, Modal, NavLink, Stack, Text } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState, loadApp, startAppUpdate } from "./data/api";
import { UpdateDot } from "./kit/UpdateDot";

/** apk's version without its package release ("0.1.5-r1" → "0.1.5"). */
const shown = (version: string) => version.replace(/-r\d+$/, "");

const releasesUrl = "https://github.com/jasrusable/openwrt-configurator/releases";

export const AppUpdateLink = () => {
  const [open, setOpen] = useState(false);
  // Once started here: the version it left, until the page reloads into the next.
  const [from, setFrom] = useState<string>();
  const [error, setError] = useState<string>();
  const app = useQuery({
    queryKey: ["app"],
    queryFn: loadApp,
    // While installing, the CGI's own files are replaced: a failed read is waited through.
    refetchInterval: (query) => (from || (query.state.data && "run" in query.state.data && query.state.data.run?.running) ? 2000 : 15 * 60_000),
    retry: from ? true : 1,
  });
  const state: AppState | undefined = app.data;
  const here = state && !("here" in state) ? state : undefined;
  const running = !!from || !!here?.run?.running;
  const failed = !running && here?.run?.done && !here.run.done.ok && here.run.to !== here.installed;
  useEffect(() => {
    // The new version answers: this page is the old one's.
    if (from && here && here.installed !== from) window.location.reload();
    if (from && here?.run?.done && !here.run.running) {
      if (!here.run.done.ok) setFrom(undefined);
    }
  }, [from, here]);
  if (!here || !(here.available || running || failed)) return null;
  const label = here.available ? `Version ${shown(here.available)} is out` : "Updating";
  const start = async () => {
    setError(undefined);
    try {
      await startAppUpdate();
      setFrom(here.installed);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <NavLink
        label="Update"
        leftSection={<IconDownload size={18} />}
        rightSection={<UpdateDot label={label} />}
        className="onc-nav"
        onClick={() => setOpen(true)}
        style={{ borderRadius: 8 }}
      />
      <Modal opened={open} onClose={() => !running && setOpen(false)} title="Update this app" centered withCloseButton={!running}>
        <Stack gap="md">
          {running ? (
            <Group gap="sm" wrap="nowrap">
              <Loader size="sm" />
              <Text size="sm">
                Installing {here.run?.to ? shown(here.run.to) : here.available ? shown(here.available) : "the new version"}. The page reloads when it is done, in a
                minute or so.
              </Text>
            </Group>
          ) : (
            <>
              <Text size="sm">
                Version {shown(here.available ?? here.run?.to ?? "")} is out; this router runs {shown(here.installed)}.{" "}
                <Anchor href={releasesUrl} target="_blank" rel="noreferrer">
                  What is new
                </Anchor>
              </Text>
              <Text size="sm" c="dimmed">
                Nothing changes on your devices until you apply: anything the new version writes differently shows in the Apply sheet as an app update.
              </Text>
            </>
          )}
          {failed && (
            <Alert color="red" title="The last update did not finish">
              This router still runs {shown(here.installed)}. Its output is in the app's state directory, app-update.log.
            </Alert>
          )}
          {error && <Alert color="red">{error}</Alert>}
          {!running && (
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOpen(false)}>
                Not now
              </Button>
              <Button onClick={() => void start()} disabled={!here.available}>
                Update
              </Button>
            </Group>
          )}
        </Stack>
      </Modal>
    </>
  );
};
