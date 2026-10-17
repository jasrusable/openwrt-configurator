// The system's rules across settings: root's password, always.
import type { FeatureModule } from "../feature";

export const systemChecks: FeatureModule["check"] = (intent, issue) => {
  // A stock device has none, and then LuCI, rpcd and SSH take any password
  // from every network that reaches it: password login off closes SSH alone.
  if (!intent.system.app_login.password) {
    issue(["system", "app_login", "password"], "required: without one, a device lets anyone log in to it with any password");
  }
};
