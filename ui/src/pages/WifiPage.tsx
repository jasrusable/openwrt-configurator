import { PasswordField, PasswordListField, TextField, Value } from "../form/fields";
import { ListSections } from "../form/ListSections";
import { SettingsPage } from "../kit/layout";

export const WifiPage = () => (
  <SettingsPage
    title="Wi-Fi"
    description="Every network is broadcast by every access point, on every band, with seamless roaming between them."
  >
    <ListSections
      name="wifi"
      addLabel="Add network"
      newItem={() => ({ ssid: "", password: "" })}
      title={(i) => <Value name={`wifi.${i}.ssid`} fallback="New network" />}
    >
      {(i) => (
        <>
          <TextField name={`wifi.${i}.ssid`} label="Name" />
          <PasswordField name={`wifi.${i}.password`} label="Password" />
          <PasswordListField
            name={`wifi.${i}.extra_passwords`}
            label="More passwords"
            description="Each works on its own, e.g. one per person."
            addLabel="Add password"
          />
        </>
      )}
    </ListSections>
  </SettingsPage>
);
