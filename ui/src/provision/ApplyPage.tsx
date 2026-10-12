// Apply (#/apply): what the saved settings change on the devices, the button
// that sends them, and the run's progress. A page rather than a panel: a run
// takes minutes, and this can stay open, or be reloaded, while it does.
import { SettingsPage } from "../kit/layout";
import { ApplyNowButton, ProvisionPanel } from "./ProvisionPanel";

export const ApplyPage = () => (
  <SettingsPage
    title="Apply to devices"
    description="Sends your saved settings to every device. If any cannot be reached afterwards, all of them roll back on their own."
    actions={<ApplyNowButton />}
  >
    <ProvisionPanel />
  </SettingsPage>
);
