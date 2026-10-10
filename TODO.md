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

- [ ] A Networks table, once there are several networks (Wi-Fi and Devices
      have theirs: `ListPage` from a `defineList` spec).
- [ ] Several networks (guest, IoT): `network` becomes `networks[]`, Wi-Fi
      picks one, and the compiler emits a VLAN, a firewall zone and DHCP per
      network.
- [ ] `npm run dev`: hot reload on a Mac (esbuild watch with live reload for
      the UI, the backend restarting on change). Production stays `onc ui`
      under Node (a Mac or Raspberry Pi) or `onc cgi` under uhttpd (a router).
- [ ] **No invalid configuration, by construction.** Cross-setting rules
      (PPPoE needs credentials, channels legal in the country, the LAN not
      overlapping the WAN) as named rules in the shared schema, and the
      choices the UI offers served by the API from the same rules, so the
      UI only offers valid values. Device-only facts (a missing 5 GHz radio)
      fail at plan time, before any change.
- [ ] Reach parity with the jaculu config before provisioning from intent:
      model quirk files (R6S packet steering, AP AQL hook, the odhcpd RA
      fix) and admin SSH login. Then diff `print-uci-commands` of both.
- [ ] Open schema questions: a second AP (`jaculu-ap-2`)? Why two SSIDs on
      one LAN? What are the extra Wi-Fi passwords for? Keep LuCI? Wi-Fi on
      a router that has radios (today only access points broadcast)?
- [ ] Version the intent schema itself, with migrations.
- [ ] Snapshot tests per feature × OpenWrt version; the rig on more than
      one version.
- [ ] `@wan_port` on swconfig devices (the WAN is a switch VLAN there).
- [ ] **Authentication before `cgi` is exposed anywhere.** The API reads and
      writes Wi-Fi passwords, and has no login: on a router anyone on the
      LAN could use it. Likely reuse rpcd's login session (`ubus call
      session access`), as LuCI does. The Mac server is loopback-only, with
      Host/Origin checks against DNS rebinding.
