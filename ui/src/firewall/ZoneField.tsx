// Which firewall zone a network is in. Membership lives on the zones (a zone
// lists its networks), so this reads and moves it there. "Its own zone"
// creates one from the network's purpose.
import { Select } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { withNetworkInZone, withNetworkZone } from "../../../src/intent/edits";
import { wanZone, zoneLabel } from "../../../src/intent/firewall";
import { Intent } from "../../../src/intent/schema";
import { applyIntent, useIntentForm } from "../form/IntentForm";
import { SettingRow } from "../kit/layout";

const ownZone = "\u0000own";

export const ZoneField = ({ index }: { index: number }) => {
  const form = useIntentForm();
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  const zones: Intent["firewall"]["zones"] =
    useWatch({ name: "firewall.zones" }) ?? [];
  const network = networks[index];
  if (!network) return null;
  const current = zones.find((z) => z.networks.includes(network.id));
  const shared = (zone: (typeof zones)[number]) =>
    zone.networks.some((id) => id !== network.id);
  return (
    <SettingRow
      label="Zone"
      description="The firewall zone it is in: what it may reach, and what may reach it."
    >
      <Select
        data={[
          {
            value: ownZone,
            label:
              current && !shared(current)
                ? zoneLabel(current, networks)
                : "Its own zone (from its purpose)",
          },
          ...zones
            // WAN covers the internet connection, not networks.
            .filter((z) => z.id !== wanZone && (z !== current || shared(z)))
            .map((z) => ({ value: z.id, label: zoneLabel(z, networks) })),
        ]}
        value={!current || !shared(current) ? ownZone : current.id}
        allowDeselect={false}
        onChange={(value) => {
          const intent = form.getValues();
          if (value === ownZone) {
            // Out of the shared zone, into a new one set up from its purpose.
            const out = {
              ...intent,
              firewall: {
                ...intent.firewall,
                zones: intent.firewall.zones.map((z) => ({
                  ...z,
                  networks: z.networks.filter((n) => n !== network.id),
                })),
              },
            };
            applyIntent(form, withNetworkZone(out, index));
          } else if (value) {
            applyIntent(form, withNetworkInZone(intent, network.id, value));
          }
        }}
        style={{ width: 260, maxWidth: "100%" }}
      />
    </SettingRow>
  );
};
