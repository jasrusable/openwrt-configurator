# OpenWrt Configurator

A CLI to provision configuration onto OpenWrt devices.

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

1. Download OpenWrt Configurator from the GitHub Releases page.
2. Download a sample configuration file.
3. Adjust your configuration file as needed.
4. Print your device uci commands: `oc print-uci-commands -c ./config.json`
5. Provision configuration to your devices: `oc provision -c ./config.json`
