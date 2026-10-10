// A zone's forwardings, as LuCI's zone editor shows them: the zones it may
// forward to, or the zones that may forward to it. Both read and write the
// firewall's one list of forwardings.
import { MultiSelect } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { Intent } from "../../../src/intent/schema";
import { useIntentForm } from "../form/IntentForm";
import { SettingRow } from "../kit/layout";
import { useZoneOptions } from "./zones";

export const ForwardingsField = ({
  index,
  direction,
  label,
  description,
}: {
  index: number;
  /** "to": zones this one forwards to; "from": zones that forward to it. */
  direction: "to" | "from";
  label: string;
  description?: string;
}) => {
  const form = useIntentForm();
  const zone: Intent["firewall"]["zones"][number] | undefined = useWatch({
    name: `firewall.zones.${index}`,
  });
  const forwardings: Intent["firewall"]["forwardings"] =
    useWatch({ name: "firewall.forwardings" }) ?? [];
  const options = useZoneOptions().filter((o) => o.value !== zone?.id);
  if (!zone) return null;
  const mine = (f: { from: string; to: string }) =>
    direction === "to" ? f.from === zone.id : f.to === zone.id;
  const other = (f: { from: string; to: string }) =>
    direction === "to" ? f.to : f.from;
  return (
    <SettingRow label={label} description={description}>
      <MultiSelect
        data={options}
        value={forwardings.filter(mine).map(other)}
        onChange={(ids) =>
          form.setValue(
            "firewall.forwardings",
            [
              ...forwardings.filter((f) => !mine(f)),
              ...ids.map((id) =>
                direction === "to"
                  ? { from: zone.id, to: id }
                  : { from: id, to: zone.id },
              ),
            ],
            { shouldDirty: true, shouldValidate: true },
          )
        }
        aria-label={label}
        style={{ width: 260, maxWidth: "100%" }}
      />
    </SettingRow>
  );
};
