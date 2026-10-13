# TODO

Open work, roughly in priority order. Remove an item when it is done; the
commit that does it is the record.

## Services without a reload trigger

Each feature declares its services, enabled and started on every apply (the
agent's `services` verb, `servicesRecords` in `src/getDeviceScript.ts`). A service whose init script has no `service_triggers`
still ignores a config change until restarted: ubihealthd has a patch that
restarts it; find which others in use are in the same position (`ubus call
service list '{"name":"<svc>","verbose":true}'` shows triggers) and restart
those whose config changed. Cover boot state and running state in the rig.

## Intent layer and web UI

The goal: a simple, Apple/UniFi-style web UI that edits a high-level *intent*
JSON file (networks, Wi-Fi, DNS over HTTPS, devices and their roles). A
compiler turns that file into today's low-level config per device and OpenWrt
version. Packages, services, DSA vs swconfig and model quirks never show in
the UI or the intent file. There is no escape hatch; the scope is one home
network; the source of truth is a JSON file, not a database.

In: `src/intent/` (one folder per feature), `onc compile`, `onc ui`/`onc cgi`
over `src/server/`, and the React UI in `ui/`.

- [ ] **No invalid configuration, by construction.** Started: cross-setting
      rules live in each feature's `checks.ts` and `rules.ts` (one main
      network, unique VLANs and ranges, Wi-Fi on an existing network) and
      inputs are constrained.
      Still to do: channels legal in the chosen country, and the LAN not
      overlapping the WAN's range. Device-only facts (a missing 5 GHz radio) fail at plan
      time, before any change.
- [ ] **Reading devices** (CLAUDE.md, "Reading devices"; the app replaces
      LuCI, status included). Done: device facts that keep themselves fresh
      (`src/deviceFacts.ts`; pages ask for stale ones, applies write them),
      the offline UCI diff on Apply (`src/applyDiff.ts`), facts in hints
      (WAN port, bands), and a live Overview (`src/status/`, `ubus` over
      SSH for now; parsers tested against output recorded from 25.12, the
      hostapd one from its documented shape, as no Wi-Fi runs in Docker:
      check it against a real access point), and finding devices where they
      are, identity checked (`src/locate.ts`: last address, settings, router
      leases by name and MAC; pinned host key and board). Done also:
      guided Add hardware (`src/discover.ts`) and login access from the
      intent (authorized keys, password login off), and the Status pages
      (Overview, Clients, Devices, Performance, Activity; read by the server's
      collector, graphs a day long; restart a service, speed test, Wi-Fi
      survey). Next, in
      order: a read-only rpcd "monitor" login compiled onto every device
      (status objects only, never UCI; its own reviewed step: hashed
      password with a stable salt); actions (reboot, restart Wi-Fi, ping)
      with a confirmation; then LuCI off the devices (uhttpd and rpcd stay;
      `rpcd-mod-iwinfo` explicit); longer history (a month at 15-minute points) last.
- [ ] Per-port network assignment (today every LAN port carries every
      network: the main one untagged, the others tagged). Also a security
      fix: a wired device can tag its frames into any network's VLAN, which
      bypasses a main network that is not allowed to reach the others.
      Only access point uplinks should be trunks.
- [ ] Full client isolation. `isolate` (hostapd) only separates clients of
      one access point and band; across access points, bands and wired
      ports it needs bridge port isolation (or routing every client through
      the router's firewall).
- [ ] Provisioning jaculu from its intent. Parity checked offline (both
      configs through the engine against the captured R6S and NWA50AX Pro
      schemas, secrets masked): the R6S and odhcpd scripts match byte for
      byte, the per-band AQL hook sets the same limits, and every other
      difference is deliberate (rebind protection on, DHCP
      pool .5-.254, ra_default 1, LuCI's cgi_prefix, DirectInterface, the
      off states of UPnP/avahi, ubihealthd kept from the device, stock
      uhttpd limits, the ULA prefix derived from the site's seed, no
      conloglevel, no curl: https-dns-proxy's HTTP/2 is libcurl's). The intent's Wi-Fi passwords
      must be the real ones before a provision (the hand config takes them
      from the keychain).
      Then a print-uci-commands against the devices, on request.
- [ ] Open schema questions: a second AP (`jaculu-ap-2`)? Why two SSIDs on
      one LAN? What are the extra Wi-Fi passwords for? Keep LuCI? Wi-Fi on
      a router that has radios (today only access points broadcast)?
- [ ] Snapshot tests per feature × OpenWrt version; the rig on more than
      one version.
- [ ] Run a line on a swconfig router on real hardware (compiled to OpenWrt's own layout, VLAN 2 with the CPU tagged; checked only against the Archer C50's schema).
- [ ] Router-hosted first run: today `/etc/onc/intent.json` must be copied there; a first-run page that starts one from the router itself (its facts, its current network) would make the package usable on its own. Also HTTPS: the session cookie travels in clear over plain HTTP, as LuCI's does.
- [ ] CLI `provision` (no `--facts-for`) still trusts an access point's `name.lan` on first use through the shared known_hosts; only the UI's apply holds it to a pin.
- [ ] **Check free storage before installing.** Packages are fixed per role (mwan3 ~2.1 MiB, the mesh's ~0.4 MiB, the full wpad), so a small-flash device (8 MB) may not fit them: read the overlay's free space as a fact and have the apply refuse before `apk add` ("needs 2.1 MiB, has 1.4"), rather than filling the flash mid-run.

## Mesh

- Run it on real hardware (two access points), then drop "Experimental".
- Mesh over cables (`wifi.mesh.over_cable`) on swconfig nodes: there the VLAN is only carried, not used.
- Tri-band access points with two 5 GHz radios: the mesh uses the first; a dedicated second 5 GHz radio needs each radio's channels in the facts.
- A QEMU OpenWrt VM with `kmod-mac80211-hwsim` for an end-to-end mesh test in CI.
- The wired mesh's MTU and path check on real switches (verified only in Docker, and a 1500-only Docker bridge as the bad switch).
- A mesh neighbour's name comes from facts' MACs: until they are re-read (a day), a new neighbour shows as a MAC and its speed test is refused.

## Status

- Clients: names learnt from mDNS; a client's type is guessed from its name only (icons).
- Wi-Fi survey and usteer roaming: run on the user's AP only once usteer and the survey are exercised there (verified in Docker).
- mwan3track's log line ("Interface wan (eth1) is offline") is from its source, not recorded: record one on a router with two lines.
- Every status read compiles each device's settings again (`getOpenWrtState`, for the services that must run and the shaped interfaces), and the collector reads every 10 s while someone looks: cheap on a Mac, to measure under QuickJS on a router.

## From the settings and apply review (2026-10-13)

- Ordering: the access point the workstation is on (by Wi-Fi) is not put last, only the gateway and a local device.
- Adopting (Hardware › Add): show the host key's fingerprint and the MAC before adopting, and take addresses only, not names.
- One root password is sent to every device: prefer keys only, the password only with password login on and no key.
- `<intent>.state` is made with the default mode (0755 under the usual umask; its files are 0600): make the directory 0700 when first made (`stateLayout`, the platforms' `mkdirp`).
- Access points get `dhcp` sections though dnsmasq and odhcpd are removed there; harmless, but noise in the apply diff.
- A misspelled config in a hand-written file (`firwall`) is not caught: configs not in `src/plan/rules.ts`' table take any section type, and `uci batch` fails on a config the device lacks unless prepare seeds it (packages changing), when the real one is then wiped as undeclared. Check declared configs against the device's at plan. (Options stay open by design; a section's required options and unknown section types are refused.)
- swconfig: the switch is `switch0` in the compiler and engine; facts drop board.json's switch name (a board whose switch is named otherwise, or with two, is wrong).
- The IPv6-follows-the-line hook (mwan3 `disconnected`/`connected`) is from mwan3's source: watch a real failover.

## Roadmap (2026-10-13)

- **Compiler changes show in the apply diff, and devices carry a stamp.** An app upgrade that changes compiled output (a new default, a patch) is invisible today: the intent diff compares intents, and the device diff is only read on the Apply page. Stamp each device at apply with a hash of what produced its config (intent version, compiler version, the compiled per-device output), e.g. in `/etc/onc/applied.json`; status then says "settings not applied" when the stamp differs from what the current compiler would produce, and the Apply page names the cause ("compiler update: <changes>") as well as edits.
- **Kept configs and sysupgrade.** `configs_to_not_reset` keeps (`luci.*`, `rpcd.*`, `ubihealthd`, LEDs, …) are never wiped, so they can drift or go stale, especially if a sysupgrade preserves `/etc/config`. Decide per keep: owned after all, regenerated, or explicitly unowned; and define what an upgrade with preserved config does (re-apply after first boot, reconcile, or flash without keeping config and let the failsafe defaults below bring it back).
- **Onboarding.** A first-run wizard: find and add devices first (discover), read them, then either adopt their current setup (an intent suggested from what they run, with the coerced/unsupported parts named) or start fresh from a template, guided step by step, so nobody starts cold.
- **Firmware updates.** Proper upgrade and flashing with a custom build (ASU, the packages each role needs), including a failsafe `uci-defaults` script so a device that is reset or freshly flashed still comes up on the network: an access point as a DHCP client of the main network, the router on the main network's address, SSH with the app's key, ready for the next apply.
- **Status pages, simpler.** Rework the Status pages to be more intuitive and useful at a glance: fewer, clearer numbers, what changed and what needs doing first.
- **More features.** Captive portal (guest network), ad blocking, scheduled firewall rules (block at times), people and device groups (James's iPhone and iPad off at 7 pm), more VPN options (servers, types), and a little more for OpenWrt power users.
- **Simple by default, advanced on demand.** Keep the intent and UI simple, with advanced panels that expand: every advanced setting has a sane default that is shown (and marked recommended) even when collapsed, so simple users never need them and power users can see and change what the defaults are, in the same UI.
