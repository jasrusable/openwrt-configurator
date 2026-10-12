# TODO

Open work, roughly in priority order. Remove an item when it is done; the
commit that does it is the record.

## Services: enabled at boot and running, as declared

Config alone does not guarantee a service runs. A provision should make each
service's boot state and running state follow the config, not just its UCI.

Checked on 25.12.5 (the rig, and read-only on jaculu-router and jaculu-ap-1):

- **Fine today: services with a procd reload trigger, e.g. `sqm`.**
  Installing the package enables it (`S50sqm`). Because of the baseline
  refresh, a config change fires its `procd_add_reload_trigger` and restarts it.
  On the router: enabled, trigger registered, cake on `eth1`.
- **Gap: services without a reload trigger, e.g. `ubihealthd`.** Its init
  script has no `service_triggers`, so `reload_config` never restarts it. A
  changed `ubihealthd` config only takes effect at the next reboot or a
  manual `/etc/init.d/ubihealthd restart`. Find which other packages in use
  (`irqbalance`, `https-dns-proxy`, `usteer`, ...) are in the same position.
- **Gap: boot state is not declared.** A service someone disabled
  (`/etc/init.d/x disable`) stays disabled after a provision, since nothing
  re-enables it. A package that does not enable itself on install never
  starts at boot.

Likely shape: a declared set of services, each `enabled` or not. Every run
`enable`s or `disable`s each one, and restarts those whose config changed but
that have no reload trigger, or starts/stops them to match. Check
`ubus call service list '{"name":"<svc>","verbose":true}'` for triggers rather
than guessing. Cover it in the rig.

## Intent layer and web UI

The goal: a simple, Apple/UniFi-style web UI that edits a high-level *intent*
JSON file (networks, Wi-Fi, DNS over HTTPS, devices and their roles). A
compiler turns that file into today's low-level config per device and OpenWrt
version. Packages, services, DSA vs swconfig and model quirks never show in
the UI or the intent file. There is no escape hatch; the scope is one home
network; the source of truth is a JSON file, not a database.

A first slice is in: `src/intent/` (schema, one compiler module per
feature), `onc compile`, `onc ui`/`onc cgi` over `src/server/handlers.ts`,
and the React UI in `ui/`.

- [ ] **No invalid configuration, by construction.** Started: cross-setting
      rules live in the schema's superRefine (one main network, unique VLANs
      and ranges, Wi-Fi on an existing network) and inputs are constrained.
      Still to do: channels legal in the chosen country, the LAN not
      overlapping the WAN's range, and the choices the UI offers served from
      the same rules. Device-only facts (a missing 5 GHz radio) fail at plan
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
      intent (authorized keys, password login off). Next, in order: a
      read-only
      rpcd "monitor" login compiled
      onto every device (status objects only, never UCI; its own reviewed
      step: hashed password with a stable salt); `/api/status` and a live
      Overview plus a Clients page (leases, Wi-Fi stations, reservations),
      with realtime graphs kept only in the browser; logs per device (drift shows
      on Apply, read live); actions
      (reboot, restart Wi-Fi, ping) over SSH with a confirmation; then LuCI
      off the devices (uhttpd and rpcd stay; `rpcd-mod-iwinfo` explicit);
      long-term history last.
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
      uhttpd limits, the ULA prefix derived from the site name, no
      conloglevel, no curl: https-dns-proxy's HTTP/2 is libcurl's). The intent's Wi-Fi passwords
      must be the real ones before a provision (the hand config takes them
      from the keychain).
      Then a print-uci-commands against the devices, on request.
- [ ] Open schema questions: a second AP (`jaculu-ap-2`)? Why two SSIDs on
      one LAN? What are the extra Wi-Fi passwords for? Keep LuCI? Wi-Fi on
      a router that has radios (today only access points broadcast)?
- [ ] Snapshot tests per feature × OpenWrt version; the rig on more than
      one version.
- [ ] `@wan_port` on swconfig devices (the WAN is a switch VLAN there).
- [ ] **Authentication before `cgi` is exposed anywhere.** The API reads and
      writes Wi-Fi passwords, and has no login: on a router anyone on the
      LAN could use it. Likely reuse rpcd's login session (`ubus call
      session access`), as LuCI does. The Mac server is loopback-only, with
      Host/Origin checks against DNS rebinding.

## Mesh

- Run it on real hardware (two access points), then drop "Experimental".
- Mesh over cables (`mesh.wired`) on swconfig nodes: there the VLAN is only carried, not used.
- Tri-band access points with two 5 GHz radios: the mesh uses the first; a dedicated second 5 GHz radio needs each radio's channels in the facts.
- A QEMU OpenWrt VM with `kmod-mac80211-hwsim` for an end-to-end mesh test in CI.

