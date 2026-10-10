import { SegmentedField, SelectField, TextField, Value, When } from "../form/fields";
import { ListSections } from "../form/ListSections";
import { SettingsPage } from "../kit/layout";

// Unset is automatic, so it is offered by `emptyLabel`, not listed here.
const channels = (numbers: number[]) =>
  numbers.map((n) => ({ value: n, label: `Channel ${n}` }));
const channels2g = channels([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
const channels5g = channels([
  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132,
  136, 140, 149, 153, 157, 161, 165,
]);

export const DevicesPage = () => (
  <SettingsPage
    title="Devices"
    description="Your router and access points. Each is set up entirely from these settings."
  >
    <ListSections
      name="devices"
      addLabel="Add device"
      newItem={() => ({ name: "", role: "access-point" as const })}
      title={(i) => <Value name={`devices.${i}.name`} fallback="New device" />}
    >
      {(i) => (
        <>
          <TextField
            name={`devices.${i}.name`}
            label="Name"
            description="Also its hostname."
          />
          <SegmentedField
            name={`devices.${i}.role`}
            label="Role"
            options={[
              { value: "router", label: "Router" },
              { value: "access-point", label: "Access point" },
            ]}
          />
          <When name={`devices.${i}.role`} is="access-point">
            <SelectField
              name={`devices.${i}.wifi.channel.2g`}
              label="2.4 GHz channel"
              options={channels2g}
              emptyLabel="Automatic"
            />
            <SelectField
              name={`devices.${i}.wifi.channel.5g`}
              label="5 GHz channel"
              options={channels5g}
              emptyLabel="Automatic"
            />
          </When>
        </>
      )}
    </ListSections>
  </SettingsPage>
);
