// The header's Save and Apply button (LuCI's "Save & Apply", for every device
// at once). It carries how many changes are waiting, saved or still in the
// draft, including 0, and opens the sheet (ApplyModal.tsx). The CLI calls it provision.
import { Button, Group, Loader } from "@mantine/core";
import { IconCloudUpload } from "@tabler/icons-react";
import { useProvision } from "../data/provision";
import { useApplySheet } from "./ApplyModal";
import { ApplyLabel, twoLineButton } from "./ApplyLabel";
import { useApplyCount, useDraftChanges } from "./pending";
import { applyStatus } from "./status";

/**
 * `quiet` while there are unsaved edits: on a phone Apply steps aside to make
 * room for Save. It stays filled either way, so the button does not change
 * colour as the count does.
 */
export const ProvisionButton = ({ quiet = false }: { quiet?: boolean }) => {
  const sheet = useApplySheet();
  const info = useProvision().data;
  const status = info && applyStatus(info);
  const running = info?.state === "running";
  const count = useApplyCount();
  const unsaved = useDraftChanges().length > 0;
  // The saved-file status says "Up to date" while the draft still differs.
  const tip =
    unsaved && count !== undefined ? `${count} change${count === 1 ? "" : "s"} to apply` : status?.short;
  return (
    <Group gap="xs" wrap="nowrap" visibleFrom={quiet ? "sm" : undefined}>
      {/* Never a loading button while a run goes: that cannot be clicked, and
          the sheet is where the run is followed (and a rollback seen). */}
      <Button
        variant="filled"
        // Sized to its label, as the sheet's own button is.
        {...twoLineButton}
        leftSection={running ? <Loader size={14} type="dots" /> : <IconCloudUpload size={16} />}
        title={tip}
        onClick={sheet.open}
      >
        <ApplyLabel count={count} running={running} opensSheet />
      </Button>
    </Group>
  );
};
