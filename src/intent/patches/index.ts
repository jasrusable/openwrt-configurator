// Every patch, in order. Adding a fix for a model, a role or a release is
// adding a file here and a line below; when OpenWrt fixes one upstream, give
// it `releases.before` the fixed release, and drop it once no device runs an
// older one.
import { odhcpdRaRestart } from "./odhcpd-ra-restart";
import { Intent } from "../schema";
import { applyPatches, patchesFor } from "./patch";
import { r6sPacketSteering } from "./r6s-packet-steering";
import { ubihealthdConfig } from "./ubihealthd-config";

export const patches = [r6sPacketSteering, odhcpdRaRestart, ubihealthdConfig];

export const patchesFeature = applyPatches(patches);

/** Which patches each device gets, one line per device, for the CLI. */
export const describePatches = (intent: Intent) =>
  [
    "Patches over OpenWrt (src/intent/patches):",
    ...patchesFor(patches, intent).map(
      ({ device, patches }) =>
        `  ${device}: ${
          patches.map(({ id, only }) => (only ? `${id} (${only})` : id)).join(", ") || "none"
        }`
    ),
  ].join("\n");
