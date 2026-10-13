// What each mesh setting is called and does, for people (fields.ts): its
// numbers come from where the compiler takes them (compile.ts).
import type { FieldInfo } from "../feature";
import { meshWiredVlan } from "../radios";
import { meshHopPenalty, meshMtu } from "./constants";

export const meshFields: FieldInfo[] = [
  { path: "wifi.mesh", label: "Mesh" },
  {
    path: "wifi.mesh.enabled",
    label: "Mesh",
    description: "Access points link over Wi-Fi, so they need no cable.",
    openwrt: "802.11s · batman-adv",
    explain: () =>
      `Access points (and the router, if it has Wi-Fi in the band) link to each other over an encrypted 802.11s mesh, with batman-adv choosing the best path over it, so an access point with only power can carry every network. A node that is also cabled is fine: batman's loop avoidance keeps it from looping. The mesh shares its radio with that band's devices, so on an access point with two radios, Wi-Fi in that band is slower. Its link carries ${meshMtu} bytes, so nothing is fragmented, and each extra hop costs ${meshHopPenalty} in batman's choice, preferring fewer.`,
  },
  {
    path: "wifi.mesh.band",
    label: "Band",
    description: "5 GHz is faster; 2.4 GHz reaches further; 6 GHz is for access points with three radios.",
  },
  {
    path: "wifi.mesh.channel",
    label: "Channel",
    description: "Every node uses it; never one a radar could move.",
    openwrt: "wifi-device channel",
    explain:
      "All mesh nodes must share one channel, so it is fixed here and the access points' own channel for this band follows it. Only channels without radar detection (DFS) are offered: on those, a radar makes an access point leave the channel, and it would drop out of the mesh.",
  },
  { path: "wifi.mesh.key", label: "Mesh key", secret: true },
  {
    path: "wifi.mesh.band_reserved",
    label: "Only for the mesh",
    description: "Devices use the other bands: the mesh has this one to itself.",
    explain:
      "No SSID is broadcast on the mesh's radio, so the mesh gets all of its airtime instead of sharing it with your devices. Best on access points with three radios: a 6 GHz one for the mesh, or with two 5 GHz radios the one on the mesh's channel, the other still serving devices. On two, devices are left with the other band alone.",
  },
  {
    path: "wifi.mesh.over_cable",
    label: "Also over cables",
    description: "Nodes with a cable between them use it, and Wi-Fi when it fails.",
    openwrt: "batman-adv on a VLAN",
    explain: () =>
      `batman-adv also runs over your cables, on VLAN ${meshWiredVlan}, carried tagged on every device's ports, older switch chips (swconfig) included (the router and access points without Wi-Fi in the mesh's band only pass it on). Between two nodes with a cable it then prefers the cable, and falls back to the mesh when it breaks. Without it, a cabled node still links the mesh to the network, and its devices still move to another one if its cable breaks; this adds the cable as a path of the mesh itself. No network may use VLAN ${meshWiredVlan}.`,
  },
  {
    path: "wifi.mesh.large_frames",
    label: "Larger frames over cable",
    description: "Faster; any switch between nodes must pass them.",
    openwrt: `MTU ${meshMtu}`,
    explain: () =>
      `The mesh adds its own header to every packet, so over cables it sends frames of ${meshMtu} bytes, ${meshMtu - 1500} more than usual: every port of your devices is set to take them (older switch chips, swconfig, stay at 1500 and split instead), your networks' own stay at 1500. Most switches pass them; one that does not drops full-size packets, which the Overview shows. Off, the mesh splits such packets in two over cable instead: it always works, a little slower.`,
  },
  {
    path: "hardware.*.uplink",
    label: "Connected",
    description: "By a cable, or over the mesh.",
    explain:
      "How this access point reaches the rest of the network. Over the mesh it needs only power; cabled, it also links the mesh into the network. Its first setup must be over a cable, as it has no mesh until then. Applying changes those over the mesh first, so a change never cuts one off halfway.",
  },
];
