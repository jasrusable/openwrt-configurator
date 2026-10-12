// The header's Apply button (LuCI's "Save & Apply", for every device at once):
// how many saved changes are not on the devices yet, and a panel with their
// preview, the confirmation and the run's progress. The CLI calls it provision.
import { Badge, Button, Drawer } from "@mantine/core";
import { IconCloudUpload } from "@tabler/icons-react";
import { useState } from "react";
import { useProvision } from "../data/provision";
import { ProvisionPanel } from "./ProvisionPanel";

const usePendingLabel = () => {
  const data = useProvision().data;
  if (!data || data.live === "matches") return undefined;
  return data.live === "none" ? "New" : String(data.changes.length);
};

export const ProvisionButton = () => {
  const [open, setOpen] = useState(false);
  const pending = usePendingLabel();
  const running = useProvision().data?.state === "running";
  return (
    <>
      <Button
        variant={pending ? "filled" : "default"}
        leftSection={<IconCloudUpload size={16} />}
        rightSection={
          pending && (
            <Badge size="sm" circle={pending !== "New"} color="white" c="blue">
              {pending}
            </Badge>
          )
        }
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
