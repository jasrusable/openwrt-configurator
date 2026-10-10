// The header's Provision button: how many saved changes are waiting, and a
// panel with their preview, the confirmation and the run's progress.
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
        loading={running}
        loaderProps={{ type: "dots" }}
        onClick={() => setOpen(true)}
      >
        Provision
      </Button>
      <Drawer
        opened={open}
        onClose={() => setOpen(false)}
        position="right"
        size="lg"
        title="Provision"
      >
        <ProvisionPanel />
      </Drawer>
    </>
  );
};
