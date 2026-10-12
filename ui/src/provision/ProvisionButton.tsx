// The header's Apply button (LuCI's "Save & Apply", for every device at once)
// and, beside it, where the devices stand in a few words; it opens the Apply
// sheet (ApplyModal.tsx). The CLI calls it provision.
import { Button, Group, Text } from "@mantine/core";
import { IconCloudUpload } from "@tabler/icons-react";
import { useProvision } from "../data/provision";
import { useApplySheet } from "./ApplyModal";
import { applyStatus } from "./status";

/**
 * `quiet` while there are unsaved edits: Save is the one primary action then,
 * and on a phone Apply steps aside to make room for it.
 */
export const ProvisionButton = ({ quiet = false }: { quiet?: boolean }) => {
  const sheet = useApplySheet();
  const info = useProvision().data;
  const status = info && applyStatus(info);
  const running = info?.state === "running";
  return (
    <Group gap="xs" wrap="nowrap" visibleFrom={quiet ? "sm" : undefined}>
      {/* The page says it at length; here, a few words, unless Save leads. */}
      {status && !quiet && (
        <Text size="sm" c="dimmed" visibleFrom="sm">
          {status.short}
        </Text>
      )}
      <Button
        variant={status?.pending && !quiet ? "filled" : "default"}
        leftSection={<IconCloudUpload size={16} />}
        title={status?.short}
        loading={running}
        loaderProps={{ type: "dots" }}
        onClick={sheet.open}
      >
        Apply
      </Button>
    </Group>
  );
};
