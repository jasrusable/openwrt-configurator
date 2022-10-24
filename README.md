# OpenWrt Configurator

A CLI to provision configuration onto OpenWrt devices.

```sh
$ openwrt-configurator provision -c my-network-config.json
```

## Features

- Declaratively define your entire network configuration in a single JSON file.
  - Specify packages to be installed or uninstalled on your devices.
  - Define configuration sections to be provisioned to your devices.
  - Configuration sections can be conditionally applied to specific devices based on tags and device attributes.
- Configuration validation and error checking.
  - Ensure that all configuration keys and values are valid and correctly specified. (e.g Prevents you from mistyping an ipv4 address)
  - Referential integrity checks to ensure that all cross-referenced configuration keys and values exist and are valid. (e.g Prevents you from defining an interface with a device that does not exist.)
- Print uci commands for each device based on your configuration.
- Easily provision your configuration to your devices.
  - Configuration is provisioned to your devices over SSH, no additional dependencies are needed.

## Getting started

#### 1. Download OpenWrt Configurator from the [GitHub Releases page](https://github.com/jasrusable/openwrt-configurator/releases).

#### 2. Download a [sample configuration file](https://github.com/jasrusable/openwrt-configurator/tree/main/sampleConfigs).

#### 3. Adjust your configuration file as needed.

#### 4. Print your device uci commands:

```sh
./openwrt-configurator print-uci-commands -c ./config.json
```

> Note: For this command to work, SSH details need to be correctly configured in the `provisioning_config` sections for each of your devices.

#### 5. Provision configuration to your devices:

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
