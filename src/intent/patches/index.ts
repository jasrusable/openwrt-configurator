// Every patch, in order. Adding a fix for a model, a role or a release is
// adding a file here and a line below; dropping one when OpenWrt fixes it
// upstream is the reverse.
import { odhcpdRaRestart } from "./odhcpd-ra-restart";
import { applyPatches } from "./patch";
import { r6sPacketSteering } from "./r6s-packet-steering";
import { wifiAirtime } from "./wifi-airtime";

export const patches = [r6sPacketSteering, odhcpdRaRestart, wifiAirtime];

export const patchesFeature = applyPatches(patches);
