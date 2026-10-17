// The mesh's rules across settings: a key once on, a channel no radar moves
// it off, and its VLAN over cables no network's or line's.
import type { FeatureModule } from "../feature";
import { meshChannels, meshWiredVlan } from "../radios";

export const meshChecks: FeatureModule["check"] = (intent, issue) => {
  const mesh = intent.wifi.mesh;
  if (!mesh.enabled) return;
  if (!mesh.key) issue(["wifi", "mesh", "key"], "required");
  if (mesh.over_cable) {
    intent.networks.forEach((n, i) => {
      if (n.vlan === meshWiredVlan) issue(["networks", i, "vlan"], `VLAN ${meshWiredVlan} carries the mesh over cables`);
    });
    // A swconfig switch's VLANs are the whole switch's (internet/checks.ts).
    intent.internet.lines.forEach((l, c) => {
      if (l.vlan === meshWiredVlan) issue(["internet", "lines", c, "vlan"], `VLAN ${meshWiredVlan} carries the mesh over cables`);
    });
  }
  if (!meshChannels[mesh.band].includes(mesh.channel)) {
    issue(["wifi", "mesh", "channel"], `one of ${meshChannels[mesh.band].join(", ")}`);
  }
};
