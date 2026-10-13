// What each hardware setting is called and does, for people (fields.ts).
import type { FieldInfo } from "../feature";

export const hardwareFields: FieldInfo[] = [
  { path: "hardware", label: "Hardware" },
  { path: "hardware.*", label: (d) => `“${d?.name || "unnamed"}”` },
  {
    path: "hardware.*.name",
    label: "Name",
    description: "Also its hostname.",
    openwrt: "system hostname",
    explain:
      "Set as the device's hostname, so it shows under this name in LuCI and on your network. Access points are reached by it too, as <name>.<local domain>.",
  },
  {
    path: "hardware.*.role",
    label: "Role",
    description: "The router runs the networks; access points broadcast Wi-Fi.",
  },
  {
    path: "hardware.*.location",
    label: "Location",
    description: "Where it is, for you: shown in LuCI too.",
    openwrt: "system description",
    explain:
      "Shown as the device's description on LuCI's status page, to tell access points apart.",
  },
  { path: "hardware.*.radios", label: "Radios" },
  {
    path: "hardware.*.radios.2g.channel",
    label: "2.4 GHz channel",
    openwrt: "wifi-device channel",
    explain:
      "Pins this access point to one channel on the band. Auto picks the clearest channel each time the access point starts; pinning keeps neighbouring access points on different channels.",
  },
  {
    path: "hardware.*.radios.5g.channel",
    label: "5 GHz channel",
    openwrt: "wifi-device channel",
    explain:
      "Pins this access point to one channel on the band. Auto picks the clearest channel each time the access point starts; pinning keeps neighbouring access points on different channels.",
  },
];
