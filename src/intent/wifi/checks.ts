// The SSIDs' rules across settings: each on a band that is broadcast, and
// joining a network that exists.
import type { FeatureModule } from "../feature";
import { where } from "../places";
import { broadcastBands } from "../radios";

export const wifiChecks: FeatureModule["check"] = (intent, issue) => {
  const ids = intent.networks.map((n) => n.id);
  intent.wifi.networks.forEach((wifi, i) => {
    // The UI cannot get here (rules.ts); a hand-edited file can.
    if (!broadcastBands(intent.wifi, wifi).length) {
      issue(["wifi", "networks", i, "bands"], `broadcast on no band: none of its radios is on, or the mesh has the band to itself (${where("radios")})`);
    }
    if (!ids.includes(wifi.network)) {
      issue(["wifi", "networks", i, "network"], "pick a network");
    }
  });
};
