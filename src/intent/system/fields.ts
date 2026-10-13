// What each system setting is called and does, for people (fields.ts).
import type { FieldInfo } from "../feature";
import { where } from "../places";

export const systemFields: FieldInfo[] = [
  { path: "system", label: "System" },
  { path: "system.name", label: "Name" },
  {
    path: "system.site_id",
    label: "Site id",
    explain:
      "What the site's own addresses and ids are derived from: its IPv6 local prefix, the mesh id, remote access clients' IPv6. Kept from the first name when the site is renamed, so a rename changes none of them.",
  },
  {
    path: "system.timezone",
    label: "Time zone",
    description: "Wi-Fi devices can set their clocks from it.",
  },
  {
    path: "system.country",
    label: "Country",
    description: "Sets the Wi-Fi channels and power allowed.",
    explain: "Sets which Wi-Fi channels and power levels are allowed; access points announce it to clients (802.11d).",
  },
  { path: "system.app_login", label: "This app's login" },
  {
    path: "system.app_login.key",
    label: "SSH key",
    openwrt: "dropbear authorized key",
    explain:
      "The private key on this computer that the app logs in to every device with, as root over SSH. Its public half must already be in each device's authorized keys (LuCI: System › Administration › SSH-Keys); the app does not install it.",
  },
  {
    path: "system.app_login.password",
    label: "Password",
    secret: true,
    openwrt: "root password",
    explain:
      "Root's password on every device: each apply sets it, so the web logins (LuCI, and this app on a router) need it. A device fresh from OpenWrt has none, and then any password logs in. The app also logs in with it over SSH when there is no key. A rollback leaves it set.",
  },
  { path: "system.firmware", label: "Firmware" },
  {
    path: "system.firmware.release",
    label: "OpenWrt release",
    description: "Latest OpenWrt, the latest of one series, or one release.",
    explain:
      `What ${where("firmware")} upgrades the devices to. Latest OpenWrt is the newest stable release of any series: it moves on to a new series once OpenWrt releases one. Latest 25.12.x is that series's newest, never the next series's. One release (25.12.5) stays put. Release candidates and snapshots never count as the latest, and nothing is flashed until you upgrade. A device can hold its own or be pinned to another. Upgrading keeps each device's settings, then applies.`,
  },
  { path: "system.ssh", label: "SSH" },
  {
    path: "system.ssh.authorized_keys",
    label: "Authorized keys",
    description: "Public keys that may log in to the devices as root.",
    openwrt: "/etc/dropbear/authorized_keys",
    explain:
      "Installed on every device by each apply, replacing what was there. Empty leaves each device's own file alone. This app's key belongs here, so it can still log in once password login is off.",
  },
  {
    path: "system.ssh.password_login",
    label: "Password login",
    description: "Off: only the authorized keys can log in. Recommended.",
    openwrt: "dropbear PasswordAuth, RootPasswordAuth",
    explain:
      `Off, only the authorized keys can log in over SSH. The web logins are closed by root's password (${where("system", "Administration", "Password")}), which each apply sets when there is one.`,
  },
];
