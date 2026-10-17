// Beside a setting's label: whether the devices have it yet. "Not applied":
// saved here, not on the devices (the saved settings against those last
// applied, GET /api/provision; nothing is marked before a first apply, when
// everything is). "Changed on <device>": the device holds something else
// for it than the last apply left (the change plan's lines from a change on
// the device, src/applyPlan.ts), as last read: the plan is read as the app
// opens and after each save, never for this.
import { Badge, Text } from "@mantine/core";
import { changeWords } from "../../../../src/applyPlan";
import { useApplyPlan } from "../../data/devices";
import { useProvision } from "../../data/provision";
import { Hint } from "../../kit/Hint";

/** Whether `path` is the setting at `other`, holds it, or is within it. */
const touches = (path: string, other: string) => path === other || other.startsWith(`${path}.`) || path.startsWith(`${other}.`);

const Mark = ({ color, label, hint }: { color: string; label: string; hint: string }) => (
  <Hint label={<Text size="xs">{hint}</Text>} width={280}>
    <Badge variant="light" color={color} size="xs" radius="sm" style={{ textTransform: "none", cursor: "help" }} tabIndex={0}>
      {label}
    </Badge>
  </Hint>
);

export const AppliedMarks = ({ name }: { name: string }) => {
  const info = useProvision().data;
  // Only what is already read: a row never starts a read of the devices.
  const plan = useApplyPlan(false).data;
  const unapplied = info?.live === "differs" ? info.changes.filter((c) => touches(name, c.path)) : [];
  const changedOn = (plan?.items ?? []).filter((i) => i.source === "drift" && i.settings?.some((s) => touches(name, s))).flatMap((i) => i.devices);
  return (
    <>
      {unapplied.length > 0 && (
        <Mark
          color="blue"
          label="Not applied"
          hint={`Saved, not on your devices yet: Apply sends it.${unapplied.length === 1 && unapplied[0].path === name ? ` ${changeWords(unapplied[0])}.` : ""}`}
        />
      )}
      {changedOn.length > 0 && (
        <Mark
          color="orange"
          label={changedOn.length === 1 ? `Changed on ${changedOn[0]}` : "Changed on devices"}
          hint={`${changedOn.join(", ")} ${changedOn.length === 1 ? "holds" : "hold"} something else for this than the last apply left, changed by hand or by another tool. Applying puts your setting back.`}
        />
      )}
    </>
  );
};
