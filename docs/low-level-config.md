# The low-level config

Most networks are better described by an intent file, edited in the web UI: you state decisions (networks, Wi-Fi, internet lines, devices by role) and the compiler writes OpenWrt's configuration for each device. The low-level config is what the compiler produces, and you can also write one by hand: UCI-like JSON, conditionally composed with `.if` and `.overrides`, so one file drives routers and access points of different models.

Write one by hand when you want UCI itself, or a package or option the intent does not cover. `openwrt-configurator compile <intent>` prints the low-level config an intent compiles to, offline: a good starting point. [`sampleConfigs/basic.json`](../sampleConfigs/basic.json) is an example.

Nothing in a low-level config protects you from yourself the way the intent's rules do: it is applied as written, and everything it does not declare is wiped (see [The wipe](how-it-works.md#the-wipe)).

## The file

The config file is JSON, and may carry `//` and `/* */` comments and trailing commas.

Its top-level keys: `devices`, `package_profiles`, `files`, `configs_to_not_reset`, `config`, `new_configs`, and `version` (the OpenWrt release `build-images` builds; a string, or `{ ".value": ..., ".overrides": [...] }` per device).

`configs_to_not_reset` lists what the wipe leaves alone: `<config>.*` for a whole config, `<config>.<section type>` for every section of a type, a leading `?` for one the device may not have. A low-level config must keep, for example, `luci.*`, `rpcd.*` and `uhttpd.*` (see `sampleConfigs/basic.json`), or they are wiped. `new_configs` names a config the device lacks and OpenWrt does not ship, so a typo cannot stage a config of its own while the real one is wiped.

## Writing one

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

## SSH access

SSH auth is `provisioning_config.ssh_auth` (`username`, optional `password` and/or `private_key_path`), or `--identity ~/.ssh/id_ed25519` (like `ssh -i`). With neither password nor key, the SSH agent is used if `SSH_AUTH_SOCK` is set. `ipaddr` and `provisioning_config` are only needed for devices you provision over SSH.

## Secrets

Secrets (Wi-Fi PSK, PPPoE password, SSH password, …) should not live in a low-level file. Use a whole-value ref and store the value in the macOS keychain:

```json
"key": { "$secret": "wifi/home" }
```

```sh
$ openwrt-configurator secrets set wifi/home
```

On a device, refs are read from `/etc/onc/secrets.json` (`{ "name": "value" }`, mode `0600`) instead. Refs are resolved at load; `secrets set` prompts for the value and there is no `get`. `print-uci-commands`, `compile` and `build-images --dry-run` redact secrets unless you pass `--show-secrets`. After provision the device still has the secret in UCI: OpenWrt needs it to run.

An intent file holds no refs (one holding a `$secret` is refused): it keeps its passwords itself, edited in the web UI, and is written owner-only (`0600`).

## Seeing what would run

`print-uci-commands` prints what `provision` would do on each device, step by step. It connects to each device read-only, as the plan depends on what is installed there.

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

Each step is one of the device-side agent's verbs with the data it is given; secrets print as `<redacted>` unless `--show-secrets`. Then:

```sh
$ openwrt-configurator provision ./network-config.json
```

## Building images

`build-images <file>` builds a sysupgrade image per device through OpenWrt's firmware selector (ASU). From a low-level config, each image is the `version` the file names for the device's `model_id`, with its packages and its config baked in as a first-boot script. (From an intent, it builds what System › Firmware would flash, from the devices' stored facts, into `<intent>.state/images/`; see [Firmware](how-it-works.md#firmware-upgrades).) `--dry-run` resolves the profiles and prints what would be built; `--out ./images` picks where they go and `--concurrency 3` how many are built at once. `verify-images` checks built images against their manifest.

A device only ever built as an image can leave out `ipaddr` and `provisioning_config`; `provision` skips it with a note. Built images bake in hostnames and LAN addresses, which is why `images/` is gitignored in a checkout.
