// The header's Apply button (LuCI's "Save & Apply", for every device at once):
// how many saved changes are not on the devices yet, and a panel with their
// preview, the confirmation and the run's progress. The CLI calls it provision.
import { Button, Drawer, Indicator } from "@mantine/core";
import { IconCloudUpload } from "@tabler/icons-react";
import { useState } from "react";
import { useProvision } from "../data/provision";
import { ProvisionPanel } from "./ProvisionPanel";

const usePendingLabel = () => {
  const data = useProvision().data;
  if (!data || data.live === "matches") return undefined;
  return data.live === "none" ? "New" : String(data.changes.length);
};

/**
 * `quiet` while there are unsaved edits: Save is the one primary action then,
 * and on a phone Apply steps aside to make room for it.
 */
export const ProvisionButton = ({ quiet = false }: { quiet?: boolean }) => {
  const [open, setOpen] = useState(false);
  const pending = usePendingLabel();
  const running = useProvision().data?.state === "running";
  return (
    <>
      <Indicator
        disabled={!pending || running}
        size={8}
        offset={4}
        color="orange"
        withBorder
        visibleFrom={quiet ? "sm" : undefined}
      >
        <Button
          variant={pending && !quiet ? "filled" : "default"}
          leftSection={<IconCloudUpload size={16} />}
          title={
            pending === "New"
              ? "Not applied to the devices yet"
              : pending
              ? `${pending} unapplied change${pending === "1" ? "" : "s"}`
              : "The devices are up to date"
          }
          loading={running}
          loaderProps={{ type: "dots" }}
          onClick={() => setOpen(true)}
        >
          Apply
        </Button>
      </Indicator>
      <Drawer
        opened={open}
        onClose={() => setOpen(false)}
        position="right"
        size="lg"
        title="Apply to devices"
      >
        <ProvisionPanel />
      </Drawer>
    </>
  );
};
