# OpenWrt Configurator

OpenWrt Configurator is a CLI tool and corresponding JSON config file which lets you specify the entire state of your network including UCI configuration, packages and device firmware versions in a single UCI-like JSON config file which can be provisioned over SSH to your OpenWrt devices from the command line.

```sh
openwrt-configurator provision -c my-network-config.json
```

The JSON config file can be conditionally composed and implements light abstractions over device ethernet ports and Wi-Fi radios to seamlessly support configuration for multiple devices, multiple different device models/types, as well as multiple device roles (Router, switch, dump-ap etc) all form a single JSON file.

```json
...
"interface": [
  {
    ".condition": "device.tag.role == 'router'",
    ".name": "wan",
    "device": "eth0",
    "proto": "pppoe",
    "username": "me@pppoe.com",
    "password": "123"
  },
  {
    ".name": "lan",
    "device": "br-lan.1",
    ".overrides": [
      {
        ".condition": "device.tag.role == 'router'",
        "override": {
          "proto": "static",
          "ipaddr": "10.0.0.1",
          "netmask": "255.255.0.0"
        }
      },
      {
        ".condition": "device.tag.role != 'router'",
        "override": {
          "proto": "dhcp"
        }
      }
    ]
  },
]
...
```

## Features

- Store all network config for all devices in a single JSON file (UCI config, packages, firmware versions and more).
- Conditionally compose your JSON file to support multiple OpenWrt devices and device roles (Routers, switches and dump-ap's etc).
- Light abstractions over ethernet ports and WiFi radios to keep multi-device configuration simple.
- Strict config syntax validation and logical error checking for configuration to prevent invalid configuration.
- Convert your JSON file into UCI commands for each of your OpenWrt devices.
- Provision your JSON file to your OpenWrt devices over SSH.
- JSON file migrations to keep your JSON file up-to-date with any UCI configuration changes/updates.
- Build and flash sysupgrade images for your devices based on your JSON file configuration.

## Getting started

#### 1. Download OpenWrt Configurator from the [GitHub Releases page](https://github.com/jasrusable/openwrt-configurator/releases)

#### 2. Download a [sample configuration file](https://github.com/jasrusable/openwrt-configurator/tree/main/sampleConfigs)

#### 3. Adjust your configuration file as needed

#### 4. Print your device uci commands

```sh
./openwrt-configurator print-uci-commands -c ./config.json
```

> Note: For this command to work, SSH details need to be correctly configured in the `provisioning_config` sections for each of your devices.

#### 5. Provision configuration to your devices

```sh
./openwrt-configurator provision -c ./config.json
```

> Note: For this command to work, SSH details need to be correctly configured in the `provisioning_config` sections for each of your devices.

## Roadmap

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
