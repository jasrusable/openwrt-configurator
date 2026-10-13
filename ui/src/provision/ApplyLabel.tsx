// The apply buttons' label (header and sheet): what the button does, with the
// number of changes waiting in small text beneath it.
import { Stack, Text } from "@mantine/core";
import { applyActionLabel } from "./pending";

export const ApplyLabel = ({
  count,
  running = false,
  opensSheet = false,
}: {
  count: number | undefined;
  running?: boolean;
  /** The header's button, which opens the sheet rather than applying. */
  opensSheet?: boolean;
}) => {
  const { title, detail } = applyActionLabel(count, running, opensSheet);
  return detail ? (
    <Stack gap={0} align="flex-start" style={{ lineHeight: 1.05 }}>
      <span>{title}</span>
      <Text span fz={11} lh={1.1} fw={400} opacity={0.85} style={{ fontVariantNumeric: "tabular-nums" }}>
        {detail}
      </Text>
    </Stack>
  ) : (
    title
  );
};

/** Two lines inside the header's usual button height, so it lines up with Revert and Save. */
export const twoLineButton = { styles: { label: { height: "auto" } } } as const;
