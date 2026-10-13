// The one mark for "an update is available": the same blue dot in the
// sidebar, System's tabs, the Firmware tab and a device's page, with what it
// means on hover. Beside words, never the only cue.
import { Box } from "@mantine/core";
import { Hint } from "./Hint";

export const UpdateDot = ({ label }: { label: string }) => (
  <Hint label={label} width={260}>
    <Box
      component="span"
      tabIndex={0}
      aria-label={label}
      style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: "var(--mantine-color-blue-6)" }}
    />
  </Hint>
);
