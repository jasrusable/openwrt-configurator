# How it works

One file describes the network. The app compiles it for each device, shows what an apply would change, and applies it to every device as one change.

```
intent file ──compile──▶ plan ──fit to each device's facts──▶ device state ──apply──▶ the devices
 (decisions)              (per role, conditions)                (UCI, packages, files, services)
```

## The intent: decisions, not configuration

An intent file holds what you decide, in your terms: the internet lines, the networks, the Wi-Fi, firewall exceptions, VPN, DNS, and each device's name and role (`router` or `access-point`, and for an access point whether it reaches the network by cable or over the mesh). [`sampleConfigs/intent.json`](../sampleConfigs/intent.json) is one.

It holds no device facts. Model, release, ports, the switch, radios and their bands are read from each device over SSH and kept beside the file (`<intent>.state/devices/`); swap a router for another model and the file does not change. Facts can grey out a choice in the UI (a band the hardware lacks), never make a file invalid.

Settings are checked against each other as you edit (one main network, unique VLANs and ranges, Wi-Fi on a network that exists, channels legal in your country per wireless-regdb, a root password set), and a choice another setting rules out is greyed with the reason. A file that fails a check is not saved.

Each feature (system, hardware, internet, networks, Wi-Fi, mesh, firewall, VPN, DNS) compiles its part. Which packages a device gets is fixed by its role, never by a setting: turning something off writes its config disabled and stops the service, so turning it on again needs no install.

## Fitting to the hardware

The compiled plan uses placeholders where hardware differs: the WAN port, every free port, the CPU port, the bridge's ports, every radio, the radios of a band, the best `htmode` a radio supports up to a width. Per device they are fitted to the facts:

- **DSA or swconfig.** A DSA board gets `bridge-vlan` sections; a swconfig board gets `switch_vlan` on its own switch (named as the board names it), with the CPU port tagged. The swconfig layout is checked against OpenWrt's own `config_generate` for the same boards (`swconfigLayout.test.ts`).
- **Radios.** Declared Wi-Fi maps to a band's radios in order. On a tri-band board, a band's pinned channel and the single-interface mesh go to the radio whose channels hold them.
- **Refused before anything changes:** a role a device cannot carry (a router with no WAN port), more radios than it has, packages that would not fit its flash.

`openwrt-configurator compile <intent>` prints the low-level config the intent compiles to, offline ([the low-level config](low-level-config.md)).

## Reviewing a change

Before an apply, each device is read and diffed against what the apply would leave. Each line is classed as one of:

- **an edit** you made,
- **an app update** (a newer version of the app writes something differently),
- **a fix** (one of the fixes below starts or stops applying),
- **a change on the device** (someone changed it by hand or in LuCI; the setting's row also says "Changed on <device>"; the apply puts it back).

Each change says how it will be noticed: a radio option restarts that radio, a network option only that network, and so on (from OpenWrt 25.12's hostapd). The plan carries a hash of each device's state; if a device changes between the review and the apply, the apply is refused and the review is read again.

From the CLI: `provision <intent> --plan` prints the same plan and applies nothing.

## The wipe

Every apply leaves each device's UCI configuration exactly as declared. Every section the file does not declare is removed, except what is kept on purpose (LuCI's own config, LEDs, the board's `ubootenv` and `fstab` where present).

This is what makes a device reproducible from the file: no leftover config from an old release, a past experiment or a package's defaults. It is also why the first apply replaces whatever a device was running. Before committing, the result is read back and compared with the declaration; any difference reverts with nothing committed.

## Applying: one change across devices

An apply runs every device as one change:

1. **Plan:** read each device, refuse anything that cannot work (above).
2. **Stage the rollback:** each device snapshots its config, managed files and services, and fetches the packages it would need to reinstall, before any device is touched.
3. **Arm:** each device starts a watchdog that restores it unless confirmed within the window (90 s by default, `--confirm-timeout`).
4. **Configure and commit** each device. The order: the device running the app, then the router (this machine's gateway), then the access point this machine is on by Wi-Fi, last; mesh repeaters deepest first.
5. **Confirm all:** reconnect to each device. If any device cannot be reached, or any watchdog has already fired, every device rolls back.
6. **Disarm all,** then run hooks and check services.

A rollback rewinds:

| | Rewound? |
|---|---|
| `/etc/config` | Yes, restored whole |
| Managed files | Restored, or deleted if this apply created them |
| Packages installed / removed by this apply | Removed / reinstalled offline from staged files |
| Services enabled at boot, running or not | Yes |
| A reboot inside the window | Config, files and boot links, from a copy made at boot; not packages |
| Root's password | No: it is what the app logs back in with |

The web UI also keeps the settings the last apply replaced, so Undo applies them again.

## Fixes over stock OpenWrt

Some things in OpenWrt are broken or badly tuned on certain hardware or releases. Each fix the app carries is a file in [`src/intent/patches/`](../src/intent/patches/), with its reason, its references (issue, PR, forum thread), where it was verified, and when it can go. Each is targeted by model, role and release range, and applies only where both the device and your settings need it. The UI marks a setting a fix overrides, and lists every fix per device. Optional ones can be turned off in System › Patches.

Current fixes:

| Fix | Why | Applies to |
|---|---|---|
| Fast roaming held off with WPA3 | mac80211 refuses a roaming client's key handed over before association completes (openwrt#23181) | SSIDs with fast roaming and WPA3, 25.12.0 on |
| Nudge never disconnects | 25.12's usteer predates `aggressiveness`: a move request is always followed by a disconnect | access points, 25.12 |
| odhcpd restarted when IPv6 advertisements stall | odhcpd starts before wan6 has a route, advertises lifetime 0 and never recovers | router |
| UPnP mappings restored after firewall reloads | a fw4 reload drops miniupnpd's chains, and it never re-adds them | router |
| wpad restarted when its package changes | swapping wpad-basic for full wpad leaves the old binary running until a reboot | when an apply swaps it |
| Flash health monitoring kept running | ubihealthd's config is written once at first boot and never remade | UBI devices |
| DHCP leases carried into RAM, once | moving an older layout's leases from flash without losing clients' names mid-apply | router |
| Channel load not advertised on the NWA50AX Pro | mt7915/mt7981 survey counters underflow after days, freezing BSS Load high (mt76#1135) | Zyxel NWA50AX Pro |
| Energy Efficient Ethernet off on the NWA50AX Pro's port | its 2.5G PHY drops link every few minutes to hours with EEE on | Zyxel NWA50AX Pro |
| Packet steering onto the R6S's big cores | generic packet steering puts WAN receive on a little core, which saturates at ~600 Mbit/s | NanoPi R6S |

Each one's test checks it applies exactly inside its release range, so a fix whose upstream fix has shipped drops out by itself on devices running that release.

## OpenWrt changes, your file doesn't

The aim: when OpenWrt renames an option, changes a default or fixes a bug, the app absorbs it and you update the app, not your file.

True today:

- **Every apply regenerates the whole config** from your file, so nothing from an older layout lingers on a device and nothing needs migrating there.
- **Release differences have a place:** fixes are targeted by release range and drop out where upstream has fixed them; a newer app version's different output is shown as "App update" lines before you apply it.
- **After a firmware upgrade, your settings are applied again,** compiled for the new release.

Not yet:

- **Only OpenWrt 25.12 or later** (and snapshots) is supported; older releases are refused before planning. The app drives `apk`, so supporting 24.10 would mean an `opkg` path, not only compiler work.
- **No major-release jump has been made yet.** Package names are fixed per feature; nothing maps them per release, which the first rename will need. Moving devices into a series the app has not been checked against needs an explicit acknowledgement.
- **The settings file format is not frozen** until the first public release; from then on every format change is a migration, run when the file is read.

## Firmware upgrades

System › Firmware picks a release for the network (latest stable, a series like `25.12`, or one release); a device follows it, holds, or is pinned. An upgrade:

- **builds** one image per board, role and release through OpenWrt's firmware selector (ASU), with the role's packages and a first-boot script that holds nothing secret (no hostname, no MAC, no password: root gets a random one), all requested before anything is flashed;
- **flashes in order:** mesh repeaters, then cabled access points, then the router, and the device running the app last. Each device downloads its own image into RAM, checks its sha256 and `sysupgrade -T`, and the run waits for it to come back on the new release before the next;
- **applies your settings again** to every device that upgraded, even if a later one stopped the run.

Downgrades and moves into a series newer than the app has been checked against are refused unless acknowledged. No image is built unless the key the app logs in with is authorized on it (a fresh image allows key login only). The upgrade path is tested in pieces in Docker; a full sysupgrade on real hardware is still on the [to-do list](../TODO.md).

## Status

The Status pages (Overview, Clients, Devices, Internet, Wi-Fi, Activity) are read by a collector: every 10 s while someone is looking, once a minute otherwise, never during an apply. It reads each device over SSH (ubus, `/proc`, `iwinfo`, `logread`), turns what changed into events (a client joined, roamed, a line failed over), and keeps a day of one-minute points and 30 days of 15-minute points. Clients are named from what they announce over mDNS unless you named them. On a router the collector is its own service (`onc-collector`), writing to RAM and copying to flash hourly.

Actions run only when you ask, one at a time: restart a service, reboot a device, restart its Wi-Fi, ping from it, a speed test, a Wi-Fi survey.

## Safety details

- **Host keys:** trusted on first use and pinned; a changed key is refused. New devices are added by IP address only, with the host key's fingerprint shown to compare before trusting it.
- **Quoting:** every value reaching a shell or `uci batch` is quoted; section names, which cannot be, are validated.
- **Secrets** are never printed: by option name and by file permission, in every diff and dry run, unless `--show-secrets`.
- **On the device,** every step is a verb of one fixed POSIX sh script with its data on stdin, never on the command line.
