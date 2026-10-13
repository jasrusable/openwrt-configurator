# OpenWrt Configurator

OpenWrt Configurator describes your whole network — every router and access point, its packages, UCI configuration and files — in one file, and applies it to your OpenWrt devices over SSH, each change one that rolls itself back if it cuts you off.

There are two ways to write that file:

- **An intent file** (`{ "schema": 1, ... }`): your network in your own terms — the internet lines, networks, Wi-Fi, firewall exceptions, VPN, DNS and your hardware — edited in a web UI (or by hand) and compiled to OpenWrt's configuration for each device. Device facts (model, ports, radios) are read from the devices, never written down. [`sampleConfigs/intent.json`](sampleConfigs/intent.json) is an example.
- **A low-level config**: UCI-like JSON, conditionally composed with `.if` and `.overrides` so one file drives routers and access points of different models. [`sampleConfigs/basic.json`](sampleConfigs/basic.json) is an example, and [the low-level config](#the-low-level-config) below documents it.

Every command takes either, except `build-images`, which needs a low-level config (an intent file names no models or release: those are read from the devices).

```sh
$ openwrt-configurator ui ./network.intent.json      # edit it in the web UI, and apply from there
$ openwrt-configurator provision ./network.intent.json
```

## Features

- One file for every device on the network: its packages, UCI config and files.
- The web UI: settings in plain terms, refused while invalid, with what each one does on the devices; status (what needs attention, clients, devices, performance, activity); and Apply, showing what will change on each device before it does.
- Each device's config is exactly what the file declares: anything else is removed (see [What a provision does](#what-a-provision-does)).
- Every device changes as one: each is armed with a rollback first, and the change is kept only once every device can be reached after it.
- Secrets out of the file: `{ "$secret": "name" }` refs, resolved from the macOS keychain (or `/etc/onc/secrets.json` on a device).
- Arbitrary files (hotplug scripts and the like), removed from devices when removed from the file.
- Light abstractions over ethernet ports and Wi-Fi radios, so one file fits different models (DSA and swconfig alike).
- Sysupgrade images built per device from the same file (`build-images`), through OpenWrt's firmware selector.

## Getting started

1. Install OpenWrt Configurator.

   On macOS, with [Homebrew](https://brew.sh):

   ```sh
   brew install jasrusable/tap/openwrt-configurator
   ```

   On an OpenWrt 25.12+ device, from the signed package feed (it pulls in `quickjs`, about 350 KB in all):

   ```sh
   wget -O /etc/apk/keys/openwrt-configurator.pem https://jasrusable.github.io/openwrt-configurator/openwrt/openwrt-configurator.pem
   echo "https://jasrusable.github.io/openwrt-configurator/openwrt/packages.adb" >> /etc/apk/repositories.d/customfeeds.list
   apk update && apk add openwrt-configurator
   ```

   On the device, `$secret` refs are read from `/etc/onc/secrets.json` (`{ "name": "value" }`, mode `0600`) instead of a keychain. A device can provision itself as well as the devices it reaches; run it under `setsid` so that losing your own SSH session to the reload does not stop it.

   Standalone binaries for macOS, Linux and Windows are also on the [GitHub Releases page](https://github.com/jasrusable/openwrt-configurator/releases).

   Each device's SSH host key is remembered the first time you connect (`~/.config/openwrt-configurator/known_hosts`; on a device, dropbear's `~/.ssh/known_hosts`), and a changed key is refused. After reflashing a device, delete its line from that file.

   The web UI needs the Node build (the macOS binary from the releases page, or `npm run ui` in a checkout): the Homebrew build runs on QuickJS, which cannot listen on a port. On a router the package serves the UI itself, at `/cgi-bin/onc/`, behind a login with the root password (refused while root has none); its settings live in `/etc/onc/intent.json`, and a service of its own (`onc-collector`) keeps the Status pages' readings, in RAM.

2. Start from a [sample](https://github.com/jasrusable/openwrt-configurator/tree/main/sampleConfigs): `intent.json` for the web UI, `basic.json` for a low-level config.

3. With an intent file, open it in the web UI (`openwrt-configurator ui <file>`, then http://127.0.0.1:8080/) and add your devices under Hardware. Or edit either kind by hand.

4. Print and inspect what would be run on each device. This connects to each device read-only, as the plan depends on what is installed there.

```sh
$ openwrt-configurator print-uci-commands ./network-config.json
#device my-ap-1
onc-agent prepare <<'ONC_DATA'
seed 31 /etc/config/wireless
config wifi-device 'radio0'
	option type 'mac80211'
...
	option key '<redacted>'
remove firewall4
end
ONC_DATA
onc-agent stage <<'ONC_DATA'
batch 63
set system.system0=system
set system.system0.hostname='my-ap-1'
...
```

   Each step is one of the device-side agent's verbs with the data it is given; secrets print as `<redacted>` unless `--show-secrets`.

   `compile` prints the low-level config an intent file compiles to, offline.

   SSH auth is `provisioning_config.ssh_auth` (`username`, optional `password` and/or `private_key_path`), or `--identity ~/.ssh/id_ed25519` (like `ssh -i`). With neither password nor key, the SSH agent is used if `SSH_AUTH_SOCK` is set.

Secrets (Wi-Fi PSK, PPPoE password, SSH password, …) should not live in the JSON file. Use a whole-value ref and store the value in the macOS keychain:

```json
"key": { "$secret": "wifi/home" }
```

```sh
$ openwrt-configurator secrets set wifi/home
```

Refs are resolved at load. `print-uci-commands`, `compile` and `build-images --dry-run` redact secrets unless you pass `--show-secrets`. An intent file keeps its passwords itself (the web UI edits them), so keep it `0600`. After provision the device still has the secret in UCI — OpenWrt needs it to run.

5. Provision: from the web UI's Apply, or

```sh
$ openwrt-configurator provision ./network-config.json
```

## What a provision does

- **The file is the whole truth.** Each device's UCI config ends up exactly as declared: every section the file does not declare is removed, except what `configs_to_not_reset` keeps (`<config>.*` for a whole config, `<config>.<section type>` for every section of a type; a leading `?` for one the device may not have). Before committing, the result is read back and checked against the declaration; any difference reverts with nothing committed. An intent file keeps what it needs itself; a low-level config must keep, for example, `luci.*`, `rpcd.*` and `uhttpd.*` (see `sampleConfigs/basic.json`), or they are wiped.
- **Commit-confirm.** Before committing, each device snapshots its state and starts a watchdog; after the commit the tool reconnects and confirms. A device that cannot be reached restores itself (config, files, packages, services) within the window (`--confirm-timeout`, 90 s by default), reboots if that still does not let it back in, and restores itself even across a restart inside the window.
- **One change.** Every device is armed before any is changed, and nothing is confirmed until all are; if any fails, the devices already changed are rolled back too. The router (your machine's gateway) and the device running the tool go last.
- Devices must run OpenWrt 25.12 or later.

## The low-level config

The config file is JSON, and may carry `//` and `/* */` comments and trailing commas.

Its top-level keys: `devices`, `package_profiles`, `files`, `configs_to_not_reset` (see [What a provision does](#what-a-provision-does)), `config`, and `version` (the OpenWrt release `build-images` builds; a string, or `{ ".value": ..., ".overrides": [...] }` per device).

1. Add your devices to the JSON config file. `ipaddr` and `provisioning_config` are only needed for devices you provision over SSH; a device that is only ever built as an image (`build-images`) can leave them out, and `provision` skips it with a note.

```json
  "devices": [
    {
      "model_id": "ubnt,edgerouter-x",
      "ipaddr": "10.0.0.1",
      "tags": { "role": "router" }, // Give the Edgerouter a tag with role of "router".
      "hostname": "my-router",
      "provisioning_config": {
        "ssh_auth": {
          "username": "root",
          "private_key_path": "~/.ssh/id_ed25519"
        }
      }
    },
    {
      "model_id": "tplink,eap245-v3",
      "ipaddr": "10.0.0.218",
      "tags": { "role": "ap" }, // Give the EAP245 a tag with role of "ap".
      "hostname": "my-ap",
      "provisioning_config": {
        "ssh_auth": {
          "username": "root",
          "password": { "$secret": "ssh/root" }
        }
      }
    }
  ],
```

2. Specify which packages you wanted installed or uninstalled on your devices.

```json
  "package_profiles": [
    {
      ".if": "device.tag.role == 'router'", // Install sqm and https-dns-proxy on the router.
      "packages": [
        "sqm-scripts",
        "luci-app-sqm",
        "https-dns-proxy",
        "luci-app-https-dns-proxy"
      ]
    },
    {
      ".if": "device.tag.role == 'ap'", // Uninstall firewall packages from ap's.
      "packages": ["-firewall", "-firewall4"]
    }
  ],
```

3. Optionally provision arbitrary files for configuration that UCI cannot express (e.g. a hotplug script to set a debugfs value). Files are written on provision and tracked in a manifest (`/etc/onc/managed_files`), so a file removed from your config is removed from the device on the next provision. Use `.if` to target specific devices.

   Two optional hooks run a command for you, and which one you want depends on what it needs:

   - **`run_after`** runs right after the file is written, which is *before* the UCI config is committed and reloaded, and **only when the file's content changed** (an apply that changes nothing restarts nothing). Use it when the command only needs the file itself.
   - **`run_after_reload`** runs after `uci commit` and `reload_config`, once the new config is actually live. Use it when the command depends on something this provision creates — an interface, a bridge, a restarted service. A hotplug script pointed at `phy1-ap0` will silently do nothing under `run_after` if *this* provision is what creates that interface. `provision` runs these over a reconnected session, after the device has been confirmed reachable, so they cannot be lost when committing drops the link. If one fails the run fails loudly, but the configuration stays committed and live — only the immediate application of it did not happen.

   Note that `files` is not the way to create a UCI config: write to `/etc/config/<pkg>` through the `config` key instead, or the new config will not be reloaded on the run that creates it.

```json
  "files": [
    {
      ".if": "device.tag.role == 'ap'", // Lower mac80211 AQL on the AP's for lower wifi latency under load.
      "path": "/etc/hotplug.d/net/20-aql",
      "mode": "0755",
      "content": "#!/bin/sh\n[ \"$ACTION\" = \"add\" ] || exit 0\ncase \"$INTERFACE\" in phy*-ap*|wlan*) ;; *) exit 0 ;; esac\nfor phy in /sys/kernel/debug/ieee80211/phy*; do\n  [ -e \"$phy/aql_txq_limit\" ] || continue\n  for ac in 0 1 2 3; do echo \"$ac 3000 6000\" > \"$phy/aql_txq_limit\"; done\ndone\n",
      "run_after_reload": "ACTION=add INTERFACE=phy1-ap0 sh /etc/hotplug.d/net/20-aql" // Apply immediately, without waiting for a reboot. After the reload, so the interface exists.
    }
  ],
```

4. Specify your UCI configuration in JSON, and add `.if` and/or `.overrides` keys to apply configuration conditionally.

   Conditions compare a device's properties: `device.tag.<key>`, `device.hostname`, `device.ipaddr`, `device.model_id`, `device.version`, `device.sw_config`, and per band (`2g`, `5g`, `6g`) `device.wifi_<band>` (it has a radio there) and `device.mesh_<band>` (one that can mesh), each `== true` or `== false`.

   | Syntax | Meaning |
   |---|---|
   | `device.tag.role == 'ap'`, `!=` | equals / differs (a list-valued tag *contains* the value) |
   | `device.tag.role in ['ap', 'switch']` | equals any of |
   | `device.version < '25.12.6'`, `<=`, `>`, `>=` | release order: numerically, an `-rc` before its release, a snapshot after its line; anything not a release matches nothing |
   | `AND` / `&&`, `OR` / `\|\|`, `NOT` / `!`, `( … )` | combine; `AND` binds tighter than `OR`; keywords in any case |
   | `'my house'`, `"jason's ap"`, `'it\'s'` | strings keep spaces; `\` escapes a quote |
   | `*` | always |

   A tag the device does not set is simply absent: `==` and `in` are false, `!=` is true. A misspelled built-in such as `device.hostnmae` is an error.

```json
  "config": {
    "dropbear": {
      "dropbear": [
        {
          "PasswordAuth": "on",
          "RootPasswordAuth": "on",
          "Port": 22,
          "BannerFile": "/etc/banner"
        }
      ]
    },
    "system": {
      "system": [
        {
          "timezone": "Africa/Johannesburg"
        }
      ]
    },
    "network": {
      "interface": [
        {
          ".name": "loopback",
          "device": "lo",
          "proto": "static",
          "ipaddr": "127.0.0.1",
          "netmask": "255.0.0.0"
        },
        {
          ".if": "device.tag.role == 'router'", // Apply the pppoe interface to only the router.
          ".name": "wan",
          "device": "eth0",
          "proto": "pppoe",
          "username": "me@pppoe.com",
          "password": { "$secret": "pppoe" }
        },
        {
          ".name": "lan",
          "device": "br-lan.1",
          ".overrides": [
            {
              ".if": "device.tag.role == 'router'", // Apply a static ip to only the router.
              "override": {
                "proto": "static",
                "ipaddr": "10.0.0.1",
                "netmask": "255.255.0.0"
              }
            },
            {
              ".if": "device.tag.role != 'router'", // Apply dhcp to all non-router devices.
              "override": {
                "proto": "dhcp"
              }
            }
          ]
        }
      ]
    },
    "wireless": {
      ".if": "device.tag.role == 'ap'", // Applies the entire "wireless" object to only devices with the "ap" tag set.
      "wifi-device": [
        {
          ".name": "radio0",
          "band": "2g"
        },
        {
          ".name": "radio1",
          "band": "5g"
        }
      ],
      "wifi-iface": [
        {
          "mode": "ap",
          "device": ["radio0", "radio1"],
          "network": "lan",
          "ssid": "my-ssid",
          "encryption": "psk2",
          "key": { "$secret": "wifi/home" }
        },
        {
          "mode": "ap",
          "device": ["radio0", "radio1"],
          "network": "guest",
          "ssid": "my-ssid-guest",
          "encryption": "none"
        }
      ]
    }
  }
```

5. Placeholders fit one file to different hardware. In a port list (`device.ports`, `bridge-vlan.ports`, `switch_vlan.ports`), `"*"` is every free physical port and `"*t"` the same tagged; a bridge VLAN's whole `"ports": "*"` is every port of its bridge, and a Wi-Fi interface's `"device": "*"` every radio. `@wan_port`, `@port:<name>` and `@cpu_port`, each optionally `.<vlan>`, name a port wherever a device is named; `@best/<width>` as a radio's `htmode` is the newest mode it supports up to that width; `@bridge_ports` as a device's `name` gives each bridge port a section of its own. A placeholder where it means nothing is refused, and text that only looks like one is written with a second `@` (`"@@wan_port"` is the SSID `@wan_port`). An override may carry `.name` to rename its section; any other unknown `.`-key is refused.

## Commands

| Command | |
|---|---|
| `ui <intent>` | serve the web UI on this machine (loopback only) |
| `provision <file>` | apply to the devices (`--no-confirm`, `--confirm-timeout`, `--rollback`, `--identity`) |
| `print-uci-commands <file>` | print what `provision` would do on each device, step by step (reads the devices) |
| `compile <file>` | print the low-level config a file compiles to (offline) |
| `build-images <file>` | build per-device sysupgrade images from a low-level config (`--dry-run`, `--out`) |
| `verify-images` | check built images against their manifest |
| `capture-device-schema <file>` | record a device's ports and radios (read-only) |
| `secrets set <name>` | store a secret in the keychain |
| `cgi <intent>` | answer one web UI request under uhttpd (what the router package runs) |
| `collect <intent>` | keep reading the devices for the Status pages (the router package's service; `ui` does it itself) |

## Roadmap

Open work is tracked in [TODO.md](TODO.md).
