// What each hardware setting is called and does, for people (fields.ts).
import type { FieldInfo } from "../feature";
import { where } from "../places";

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
    description: "The router runs the networks; access points broadcast Wi-Fi, and so can the router.",
  },
  {
    path: "hardware.*.location",
    label: "Location",
    description: "Where it is, for you: shown in LuCI too.",
    openwrt: "system description",
    explain:
      "Shown as the device's description on LuCI's status page, to tell access points apart.",
  },
  {
    path: "hardware.*.firmware",
    label: "Firmware",
    description: "Follow the network's release, hold, or pin one.",
    explain:
      `Unset, it upgrades with the rest of the network (${where("firmware")}). Hold keeps what it runs; a pinned release is what it moves to, older ones too (a downgrade, ticked when upgrading).`,
  },
  {
    path: "hardware.*.wifi",
    label: "Broadcast Wi-Fi",
    description: "Your Wi-Fi networks from the router too, where it has radios.",
    openwrt: "wireless wifi-device disabled, wifi-iface",
    explain:
      "On, the router's radios carry every SSID as an access point's do, with fast roaming between them and the access points. Off, its radios are off and only the access points broadcast. A router without radios has nothing to broadcast either way.",
  },
  { path: "hardware.*.radios", label: "Radios" },
  {
    path: "hardware.*.radios.2g.channel",
    label: "2.4 GHz channel",
    openwrt: "wifi-device channel",
    explain:
      "Pins this device to one channel on the band. Auto picks the clearest channel each time it starts; pinning keeps neighbouring access points on different channels.",
  },
  {
    path: "hardware.*.radios.5g.channel",
    label: "5 GHz channel",
    openwrt: "wifi-device channel",
    explain:
      "Pins this device to one channel on the band. Auto picks the clearest channel each time it starts; pinning keeps neighbouring access points on different channels.",
  },
];
