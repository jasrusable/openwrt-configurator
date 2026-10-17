# Installing

The app runs in one place per network: on the router itself, or on a computer on the network. Devices must run **OpenWrt 25.12 or later** (or a snapshot).

> **Before your first apply:** the first apply replaces each device's existing configuration entirely (see [the wipe](how-it-works.md#the-wipe)). Back up each device first (LuCI › System › Backup / Flash Firmware › Generate archive, or `sysupgrade -b /tmp/backup.tar.gz`), and review the change plan before applying.

## On the router (OpenWrt package)

From the signed package feed (it pulls in `quickjs`, about 350 KB in all):

```sh
wget -O /etc/apk/keys/openwrt-configurator.pem https://jasrusable.github.io/openwrt-configurator/openwrt/openwrt-configurator.pem
echo "https://jasrusable.github.io/openwrt-configurator/openwrt/packages.adb" >> /etc/apk/repositories.d/customfeeds.list
apk update && apk add openwrt-configurator
```

Then open `http://<router>/cgi-bin/onc/` (or `https://` where uhttpd serves it) and log in with the router's root password (login is refused while root has none: set one first). With no settings saved yet, the first page starts a new network from its name, country, time zone and root password, or restores a backup. The settings live in `/etc/onc/intent.json`; the `onc-collector` service keeps the Status pages' readings in RAM, copied to flash hourly.

The router can apply to itself as well as the access points it reaches. From a shell, run it under `setsid` so that losing your own SSH session to the reload does not stop it.

## On a Mac

With [Homebrew](https://brew.sh):

```sh
brew install jasrusable/tap/openwrt-configurator
```

It installs the Node build with the web UI (Homebrew's `node` comes with it):

```sh
openwrt-configurator ui ./network.intent.json     # then http://127.0.0.1:8080/
```

`ui` listens on loopback only, with no login, and reads the devices for the Status pages while it runs.

## Release binaries

Standalone binaries (Linux x64, macOS x64 and arm64, Windows), the QuickJS bundle (`openwrt-configurator.mjs`, what the router package runs) and the Node build with its web UI (`openwrt-configurator-node.tar.gz`: run `bin/openwrt-configurator.js` with Node 24) are on the [releases page](https://github.com/jasrusable/openwrt-configurator/releases), each with a `.sha256`. The binaries carry the web UI.

## From source

```sh
git clone https://github.com/jasrusable/openwrt-configurator
cd openwrt-configurator
npm install
npm run ui -- ./network.intent.json      # build the UI and serve it on http://127.0.0.1:8080
npm test                                 # all offline
```

Node 24 (`.node-version`).

## Planned

A Linux server install (a Raspberry Pi, a NAS, a VM) with a Docker image and a systemd unit, login, and one-click app updates is planned: see [the release plan](release-plan.md).

## Logging in to devices

The app logs in to each device as root over SSH, with the key in System › Administration (`system.app_login.key`, e.g. `~/.ssh/id_ed25519`) or root's password (`system.app_login.password`, required: it is also set on every device, since a stock root has none). Turning password login off is refused unless the app's own key is among the authorized keys, so an apply cannot lock it out.

Host keys are trusted on first use and pinned (`~/.config/openwrt-configurator/known_hosts`); a changed key is refused. New devices are added in Hardware › Add by IP address, with the host key's fingerprint shown (as `dropbearkey -y` prints it on the device) to compare before trusting it. After a reset or reflash, its Hardware page shows the new fingerprint to compare and confirm.
