# Sample configurations

This directory contains a collection of sample configuration files. These configurations can be used for reference and can be downloaded and adjusted as needed.

## [Basic]()

### Configuration description

- Devices:
  - Ubiquity EdgeRouter X as a `router`. (DSA)
  - Tp-Link EAP245v3 as a `dump ap`. (swconfig)
- Networks:
  - `lan` on `10.0.0.0/16`
  - `guest` on `10.1.0.0/16`
- Firewall:
  - Default as on fresh install.
- WiFi:
  - `my-ssid` on `lan` network, on both `2g` and `5g` radios.
  - `my-ssid-guest` on `guest` network, on both `2g` and `5g` radios.
