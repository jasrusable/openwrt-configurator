# FAQ

**This is early.** It is tested end to end in Docker and against board data captured from real devices, but has barely met real hardware yet. Feedback and testers are very welcome: see [the last question](#how-do-i-report-a-bug-or-help-test).

### Does it replace LuCI?

It is meant to cover what a home network needs, status included, so you rarely open LuCI. LuCI stays installed on every device (`luci-ssl`), and its own config is kept by the wipe. Changes made in LuCI to anything the app manages are shown as drift and put back on the next apply (below).

### What happens to my existing configuration?

The first apply replaces it. Every device ends up with exactly the configuration your settings describe; anything else in `/etc/config` is removed (LuCI's config, LEDs and the board's `ubootenv`/`fstab` are kept). Back up first, and read the change plan the Apply sheet shows before applying. There is no import of an existing setup yet.

### Which devices and releases?

- **OpenWrt 25.12 or later** (or a snapshot). Older releases are refused: the app drives `apk`.
- **DSA and swconfig** switches, routers and access points.
- **Roles:** one router, and any number of access points, by cable or over the mesh.
- **Hardware:** built against a FriendlyElec NanoPi R6S as the router and Zyxel NWA50AX Pro access points (board data captured from them; fixes for both). Also checked offline against board data captured from devices: Banana Pi BPI-R4 (Wi-Fi 7, several radios), TP-Link Archer C50 v4 and C60 v2 (swconfig, checked against OpenWrt's own `config_generate`), Ubiquiti EdgeRouter X. Applied end to end in Docker on every CI run (25.12.0, 25.12.5 and SNAPSHOT).

Other boards should work if OpenWrt supports them; tell us how it goes.

### Does the router broadcast Wi-Fi?

Yes, wherever it has radios: every SSID goes out from the router as from an access point, with fast roaming between them. A single all-in-one router is a complete network on its own. To leave Wi-Fi to the access points, turn off Broadcast Wi-Fi on the router (Settings › Hardware); its radios are then written off. The wireless mesh is between access points only: the router joins it by cable.

### Can I still change things by hand, or in LuCI?

You can, but the file is the truth. Before an apply, each device is read and every difference is shown: a setting changed on a device shows "Changed on <device>" on its row, and the apply puts it back. For something the settings do not cover, there is no escape hatch in the web UI; a hand-written [low-level config](low-level-config.md) is the way to drive UCI directly.

### Is it safe?

An apply is one change across every device: each is armed with a watchdog first, configured, then confirmed by reconnecting. If any device cannot be reached afterwards, every device rolls back (config, managed files, packages, services), within 90 s by default, even across a reboot. The change plan is read from the devices and refused if one changed between review and apply. Undo applies the previous settings again. See [how it works](how-it-works.md#applying-one-change-across-devices).

What a rollback does not rewind: root's password (it is what the app logs back in with).

### What happens when OpenWrt changes?

Every apply regenerates the whole config from your settings, fixes for OpenWrt bugs are targeted by release and drop out once upstream fixes them, and after a firmware upgrade your settings are applied again. Only 25.12 is supported so far, so no major-release jump has been made yet. See [OpenWrt changes, your file doesn't](how-it-works.md#openwrt-changes-your-file-doesnt).

### What isn't supported yet?

- Choosing networks per port: every LAN port carries every network (the main one untagged, the others tagged).
- Client isolation across access points (an isolated SSID is isolated on each access point, not between them).
- Importing an existing configuration; a guided first-run wizard.
- Experimental: the mesh (verified in Docker, not yet on two real access points), VPN providers, remote access and site-to-site, dynamic DNS.
- Firmware upgrades are built and tested in pieces, not yet end to end on real hardware.
- swconfig routers are checked offline against OpenWrt's layout, not yet on a real switch.
- Releases before 25.12.

The full list is [TODO.md](../TODO.md).

### Where does it run?

On the router (an OpenWrt package with the web UI at `/cgi-bin/onc/`), or on a Mac or another machine with the web UI on `127.0.0.1:8080`. A Linux server and Docker install is planned. See [installing](install.md).

### How do I report a bug or help test?

Open an issue on [GitHub](https://github.com/jasrusable/openwrt-configurator/issues) with your OpenWrt release, the device models and their roles, and what you saw. Useful without sharing anything private:

- `openwrt-configurator provision <intent> --plan`: the change plan (secrets redacted).
- A device's board facts: `capture-device-schema` records ports and radios, read-only.

Never paste your intent file whole: it holds your Wi-Fi and root passwords.
