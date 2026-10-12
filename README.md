# OpenWrt Configurator

OpenWrt Configurator is a CLI tool and corresponding JSON config file which lets you specify the entire state of your network including UCI configuration, packages and firmware versions in a single UCI-like JSON config file which can be provisioned to your OpenWrt devices using OpenWrt Configurator.

```sh
$ openwrt-configurator provision ./network-config.json
```

The JSON config file can be conditionally composed with `.if` and/or `.overrides` keys, and implements light abstractions over device ethernet ports and Wi-Fi radios to seamlessly support configuration for multiple devices, different device models/types, as well as different device roles (Router, switch, dump-ap etc) from a single JSON config file.

```json
  "interface": [
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
    },
  ]
```

## Features

- Store all network config for all devices in a single UCI-like JSON config file (UCI config, packages, firmware versions and more).
- Keep Wi-Fi / PPPoE / SSH secrets out of that file with `{ "$secret": "name" }` refs, resolved from the macOS keychain at provision time.
- Provision arbitrary files (e.g. hotplug scripts) for config that UCI can't express, removed from devices when removed from config.
- Conditionally compose your JSON file to support multiple OpenWrt devices, different device models/types, and different roles (Routers, switches and dump-ap's etc).
- Light abstractions over ethernet ports and WiFi radios to keep multi-device configuration simple.
- Strict config syntax validation and logical error checking for configuration to prevent invalid configuration.
- Convert your JSON file into UCI commands for each of your OpenWrt devices.
- Provision your JSON file to your OpenWrt devices.
- JSON file migrations to keep your JSON file up-to-date with any UCI configuration changes/updates.
- Build and flash sysupgrade images to your OpenWrt devices based on your JSON config file.

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

   `provision` treats all the devices in the file as **one change**: every device is armed with a rollback before any is touched, and only when every one of them can be reached afterwards is the change kept. If any fails, the devices already changed are rolled back too. The router (your machine's gateway) and the device running the tool are provisioned last.

   Each device's SSH host key is remembered the first time you connect (`~/.config/openwrt-configurator/known_hosts`; on a device, dropbear's `~/.ssh/known_hosts`), and a changed key is refused. After reflashing a device, delete its line from that file.

2. Download a [sample configuration file](https://github.com/jasrusable/openwrt-configurator/tree/main/sampleConfigs).

3. Adjust your configuration file as needed.

4. Print and inspect your device UCI commands.

```sh
$ openwrt-configurator print-uci-commands ./network-config.json
# device my-ap
apk del --rdepends firewall firewall4
uci set system.system0=system
uci set system.system0.hostname='my-ap'
uci set system.system0.timezone='Africa/Johannesburg'
uci set network.switch0=switch
uci set network.switch0.name='switch0'
uci set network.switch0.reset='1'
uci set network.switch0.enable_vlan='1'
...
```

> Note: SSH auth is `provisioning_config.ssh_auth` (`username`, optional `password` and/or `private_key_path`). Or pass `--identity ~/.ssh/id_ed25519` (like `ssh -i`). With neither password nor key, the SSH agent is used if `SSH_AUTH_SOCK` is set.

Secrets (Wi-Fi PSK, PPPoE password, SSH password, …) should not live in the JSON file. Use a whole-value ref and store the value in the macOS keychain:

```json
"key": { "$secret": "wifi/home" }
```

```sh
$ openwrt-configurator secrets set wifi/home
```

`provision`, `print-uci-commands` and `build-images` resolve refs at load. `print-uci-commands` and `build-images --dry-run` redact resolved values as `{ $secret: wifi/home }` unless you pass `--show-secrets`. After provision the device still has the secret in UCI — OpenWrt needs it to run.

5. Provision configuration to your devices (Implemented with SSH).

```sh
$ openwrt-configurator provision ./network-config.json
Provisioning device "my-ap" @ root@10.0.0.218
Connecting over SSH...
Connected.
Verifying device...
Verified.
Setting configuration...
Configuration set.
Provisioning completed.
...
```

> Note: SSH auth is `provisioning_config.ssh_auth` (`username`, optional `password` and/or `private_key_path`). Or pass `--identity ~/.ssh/id_ed25519` (like `ssh -i`). With neither password nor key, the SSH agent is used if `SSH_AUTH_SOCK` is set.

## How it works

The config file is JSON, and may carry `//` and `/* */` comments and trailing commas.

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

   - **`run_after`** runs immediately after the file is written, which is *before* the UCI config is committed and reloaded. Use it when the command only needs the file itself.
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

   Conditions compare a device's properties: `device.tag.<key>`, `device.hostname`, `device.ipaddr`, `device.model_id`, `device.version` and `device.sw_config`.

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
    ],
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

## Roadmap

Open work is tracked in [TODO.md](TODO.md).

### Short-term

- Improve README.md and add more documentation.
- Add more configuration validation and error checking.
- Improve error handling and messages.
- Add more sample configurations.
- Support firmware building and flashing.

### Long-term

- Configuration migrations.
- Reduce CLI executable size.
- Web UI for building configuration.
