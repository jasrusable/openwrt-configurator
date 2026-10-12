// Apply, as LuCI does it: a sheet over the page you are on, opened by the
// header's Apply button. What the saved settings change on the devices, the
// button that sends them, and the run's progress. Open while the URL says
// "?apply", so a reload during a run (minutes) opens it again; closing it
// leaves a run going.
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useSearchParams } from "react-router";
import { useProvision, useStartProvision } from "../data/provision";
import { useDraftChanged } from "../form/IntentForm";
import { ProvisionPanel } from "./ProvisionPanel";

/** Whether the Apply sheet is open, and the ways to open and close it. */
export const useApplySheet = () => {
  const [params, setParams] = useSearchParams();
  const set = (open: boolean) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (open) next.set("apply", "");
        else next.delete("apply");
        return next;
      },
      { replace: !open }
    );
  return { opened: params.has("apply"), open: () => set(true), close: () => set(false) };
};

export const ApplyModal = () => {
  const sheet = useApplySheet();
  const provision = useProvision();
  const start = useStartProvision();
  const unsaved = useDraftChanged();
  const info = provision.data;
  const running = info?.state === "running";
  return (
    <Modal
      opened={sheet.opened}
      onClose={sheet.close}
      title={<Text fw={600}>Apply to devices</Text>}
      size="xl"
      radius="md"
      // Pages switch without animation; a sheet over them fades in once.
      transitionProps={{ duration: 120 }}
      fullScreen={window.matchMedia?.("(max-width: 48em)").matches}
    >
      <Stack gap="lg">
        <Text size="sm" c="dimmed">
          Sends your saved settings to every device
          {info?.devices.length ? ` (${info.devices.join(", ")})` : ""}. It takes a few minutes, and devices may
          briefly drop off the network. If any cannot be reached afterwards, all of them roll back on their own.
        </Text>
        <ProvisionPanel />
        {start.error && (
          <Alert color="red" title="Could not start">
            {(start.error as Error).message}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={sheet.close}>
            Close
          </Button>
          <Button
            disabled={!info || unsaved || running}
            loading={running || start.isPending}
            loaderProps={{ type: "dots" }}
            onClick={() => start.mutate()}
          >
            Apply
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
