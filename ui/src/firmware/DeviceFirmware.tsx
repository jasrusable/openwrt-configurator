// One device's firmware setting (hardware.*.firmware: follow the network,
// hold, or pin a release) and where it stands, as both System › Firmware's
// table and the device's own page in Hardware show it: one field, one value.
import { Anchor, Group, Text } from "@mantine/core";
import { ReactNode } from "react";
import { FirmwareRow, releaseNotesUrl, Releases } from "../../../src/firmware/target";
import type { Intent } from "../../../src/intent/schema";
import { compareReleases } from "../../../src/release";
import { useFirmwareRows, useReleases, useRunning, useUpdates } from "../data/firmware";
import { labelOf } from "../form/fields/binding";
import { UpdateDot } from "../kit/UpdateDot";
import { useDraftValue } from "../form/draft";
import { SelectField } from "../form/fields";

/** Every stable release known, newest first. */
export const allReleases = (releases?: Releases) =>
  Object.values(releases?.series ?? {})
    .flat()
    .sort((a, b) => compareReleases(b, a) ?? 0);

/** Values the settings hold that the releases read do not list (offline, or a release since withdrawn), kept choosable. */
export const withHeld = (values: string[], held: (string | undefined)[]) => [
  ...new Set([...values, ...held.filter((v): v is string => !!v && v !== "hold")]),
];

/** Where a device stands, in words. */
export const standing = (row: FirmwareRow): ReactNode => {
  const target = row.target.kind === "release" ? row.target.version : undefined;
  switch (row.state) {
    case "not-read":
      return "Not read yet: what it runs is known once it is reached.";
    case "held":
      return row.running ? `Held at ${row.running}.` : "Held.";
    case "unknown":
      return `Runs ${row.running}. ${row.target.kind === "unknown" ? `The ${row.target.series} releases have not been read yet.` : ""}`;
    case "current":
      return `Up to date: ${row.running}.`;
    case "update":
      return (
        <>
          Runs {row.running}: {target} is out (
          <Anchor href={releaseNotesUrl(target!)} target="_blank" rel="noreferrer" size="xs">
            notes
          </Anchor>
          ).
        </>
      );
    case "downgrade":
      return `Runs ${row.running}: goes back to ${target} when you upgrade and tick the downgrade.`;
  }
};

/** Device `index`'s firmware choice, with where it stands beneath unless the row says it otherwise. */
export const DeviceFirmwareField = ({ index, label, description }: { index: number; label?: ReactNode; description?: ReactNode }) => {
  const intent: Intent = useDraftValue();
  const name = intent.hardware[index]?.name;
  const row = useFirmwareRows().find((r) => r.device === name);
  const running = useRunning();
  const runs = name ? running[name]?.version : undefined;
  const releases = useReleases().data?.releases;
  // An older one is a downgrade: offered, said so, and ticked when upgrading.
  const pins = withHeld(allReleases(releases), [intent.hardware[index]?.firmware]).map((v) => {
    const older = !!runs && (compareReleases(v, runs) ?? 0) < 0;
    return { value: v, label: `Pin ${v}`, reason: older ? `Older than the ${runs} it runs: a downgrade.` : undefined };
  });
  // The same dot as the sidebar's, on a device that can update.
  const updates = useUpdates();
  const shown = label ?? labelOf(`hardware.${index}.firmware`);
  return (
    <SelectField
      name={`hardware.${index}.firmware`}
      label={
        name && updates?.devices.includes(name) ? (
          <Group gap={6} wrap="nowrap" component="span">
            {shown}
            <UpdateDot label={updates.text} />
          </Group>
        ) : (
          shown
        )
      }
      description={description ?? (row && <Text size="xs" c="dimmed" component="span">{standing(row)}</Text>)}
      emptyLabel="Follow the network"
      options={[{ value: "hold", label: "Hold" }, ...pins]}
    />
  );
};
