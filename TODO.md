# TODO

Open work, roughly in priority order. Remove an item when it is done; the
commit that does it is the record.

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
      Done also: channels legal in the chosen country (wireless-regdb,
      `scripts/gen-regdb.js`), a static line's range not over a network's,
      and a device that cannot carry its part (no WAN port) refused at plan
      in plain words. Still to do: a DHCP line's range over a network's is
      only known at runtime (an ISP router on 192.168.1.x): a Status warning.
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
      collector, graphs a day at a minute and 30 days at 15 minutes; restart a service, speed test, Wi-Fi
      survey; reboot, restart Wi-Fi and ping from a device, each confirmed).
      Next: LuCI off the devices (an open question for you: uhttpd and
      rpcd stay; `rpcd-mod-iwinfo` explicit).
- [ ] **A read-only "monitor" login for status reads: designed, verified,
      not built; your call.** Status reads log in over SSH as root. The
      alternative: an rpcd user compiled onto every device, its ACL only the
      ubus objects, files and execs the probes need, read over `/ubus`.
      Verified on 25.12.5: an rpcd login with an MD5-crypt hash and its own
      ACL works; `system info` and `file read` of an allowed path answer,
      `uci` and `/etc/shadow` are refused; JSON-RPC batches over `/ubus`
      (uclient-fetch `--post-data`) carry many calls in one request.
      Not built, because it is not clearly better:
      1. Privilege: the collector runs beside the apply path, on the same
         machine as the same user holding the root login (the Mac's
         server; root on a router), so a lesser login for reads takes no
         root credential away from that host.
      2. Transport: plain HTTP is the only cheap form (one request per
         read, no handshake), but it sends the login and every status
         answer (clients, MACs, logs) in clear on the main network, where
         SSH keeps them encrypted today: a new weak spot. HTTPS needs each
         device's self-signed uhttpd certificate pinned like host keys
         (`--ca-certificate` with the device's own; whether ustream-ssl
         also checks the name is not verified) and costs a TLS handshake
         per read, close to SSH's.
      3. Cost: a pure-TS crypt (QuickJS has no crypto), a new generated
         secret in the intent, an ACL kept in step with every probe, and
         the probes (shell batches over ubus, /proc, sysfs, batctl, wg,
         logread, iwinfo) rewritten as ubus and file calls, SSH kept for
         the rest.
      Worth it if the collector moves to a host or user without root
      credentials, or if pinned HTTPS proves simple; the router's read cost
      is better cut by caching the compiled state.
- [ ] Per-port network assignment (today every LAN port carries every
      network: the main one untagged, the others tagged). Also for drivers that filter only a few VLANs: the R6S's eth0
      handles about 3 (https://github.com/openwrt/openwrt/issues/16162; Status warns,
      `vlanFilterLimits` in src/status/views.ts), so only the networks it needs. Also a security
      fix: a wired device can tag its frames into any network's VLAN, which
      bypasses a main network that is not allowed to reach the others.
      Only access point uplinks should be trunks.
- [ ] Full client isolation across access points and wired ports. An
      isolated SSID has hostapd's isolation and the access point's bridge
      port isolation (`bridge_isolate`): its clients reach neither each
      other nor the access point's other isolated SSIDs and bands. Across
      access points they still can: an isolated port reaches every port
      that is not, and the uplinks carry every network (verified on a Linux
      bridge). Needs per-port networks first (wired ports netifd cannot
      isolate by UCI at all), then filtering on the uplinks, or every
      client routed through the router's firewall.
- [ ] Provisioning the live network from its intent. Parity checked offline (both
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
- [ ] Open schema questions: a second AP (`ap-2`)? Why two SSIDs on
      one LAN? What are the extra Wi-Fi passwords for? Keep LuCI?
- [ ] **A broadcasting router and the mesh's reserved band.** The router is not
      a mesh node (it joins by cable), yet `wifi.mesh.band_reserved` keeps its
      SSIDs off the mesh's band too, and its radio there takes the mesh's
      channel: that radio sits idle. Reserve the band on mesh nodes only.
- [ ] **`npm run equivalence` is noisy.** On a clean tree, every device differs
      from HEAD by a duplicated `?ubootenv.*`/`?fstab.*` keep (HEAD's worktree
      lists them twice), and a new intent key makes HEAD refuse every
      generated intent: compare the corpus parsed by each side's own schema.
- [ ] Run a line on a swconfig router on real hardware. The layout is checked
      offline against OpenWrt's own (`swconfigLayout.test.ts`: the Archer C50
      v4 and C60 v2 boards generated by OpenWrt's ucidef_add_switch, run
      through its config_generate): the main network's VLAN, the CPU tagging,
      the WAN's VLAN or NIC all match. A real switch (its port order, the CPU
      port's tagging on the wire) is what is left.
- [ ] OpenWrt SNAPSHOT: a "wipe" rollback leaves the device without SSH
      (25.12 passes). procd runs each service in a cgroup; the agent and its
      watchdog, started from an SSH session, stay in dropbear's
      (`/services/dropbear/instance1`, "failed to remove busy cgroup"), and the
      snapshot's procd does not start dropbear again while they hold it. The
      agent should move what outlives the session (the watchdog at least) out
      of that cgroup. The rig's snapshot job shows it.
- [ ] Router-hosted first run: today `/etc/onc/intent.json` must be copied there; a first-run page that starts one from the router itself (its facts, its current network) would make the package usable on its own. Also HTTPS: the session cookie travels in clear over plain HTTP, as LuCI's does.


- [ ] **Off is always explicit, tested.** For every service a feature installs on a role, compiling with that feature off must give an explicit off state (a disabled section, `ignore 1`, or the service declared `enabled: false` so it is stopped and disabled at boot), never just "no config". Missing config counts as off only when the package is not installed on that role (dnsmasq and odhcpd on access points). A test walks every feature's services × roles over the generator's intents and fails on a service that is installed, unused and not declared off; each package's "no section" behaviour stays checked against its init script on the image (miniupnpd starts without one, https-dns-proxy rewrites dnsmasq).

- [ ] **DHCP identity with `sendclientid`.** Devices identify by MAC today (no `dhcp_default_duid`, see src/intent/networks/compile.ts). Once every device runs a release with `sendclientid` (commit eae2afc352, after 25.12.5), consider a stable DUID derived from the site seed and the device's name (survives a WAN port or hardware change) with `sendclientid` set per line so DHCPv4 sends no RFC 4361 client-id. Changing it renumbers each device once: plan it, and never on an access point mid-apply.
- [ ] **UPnP options a later release brings:** `ext_allow_private_ipv4` (packages commit 6f657eb190, master 2026-04-19; https://github.com/openwrt/packages/pull/28644) and `upnp_lease_file6` (IPv6 pinholes surviving a restart; packages commit 9aaf2ffb96, master 2026-01-12), neither in 25.12.5's miniupnpd init script (checked): gate both by release when one ships them.

## Mesh

- Run it on real hardware (two access points), then drop "Experimental".
- A QEMU OpenWrt VM with `kmod-mac80211-hwsim` for an end-to-end mesh test in CI.
- The wired mesh's MTU and path check on real switches (verified only in Docker, and a 1500-only Docker bridge as the bad switch).

## Status

- Clients: a client's kind also from its DHCP vendor class (option 60), which dnsmasq's lease file does not keep (a `dhcp-script` or `log-dhcp` would). Names and kinds from mDNS (umdns), its name and a few makers are done.

## From the settings and apply review (2026-10-13)

- One root password is sent to every device: prefer keys only, the password only with password login on and no key.

## From the full review (2026-10-17)

- **Root's password on flash.** `/etc/onc/root-password` (0600) stays after `passwd` read it: deleting it would rewrite it, and run `passwd`, on every apply. Needs an engine kind of file that is stamped by a hash, not kept.
- **Logging in after a password change was undone.** Root's password is not rewound by a rollback (it is said so per device), but an Undo or a reverted draft then logs in with the old one. A fallback to the previous live password would close it.
- **Offline reinstall of removed packages** stages the feed's current version, not the one installed (`apk fetch`), and not its dependencies: fetch `name=version` once checked on a device with apk v3.
- **Two adopts under one name** (two tabs, before a save) overwrite each other's facts and pin; only the draft's check stops it. Refusing a name with facts would break replacing a removed device, whose facts are kept on purpose.
- **Two first-boot scripts:** low-level `build-images` (`getBuildPlan.getUciDefaultsScript`) and intents (`firmware/firstBoot.ts`). Profiles are found one way now (`findProfile`); merging the scripts changes low-level images.
- **Shaping two lines on one port:** an untagged and a tagged line on one DSA port both shape the bare port (`sqm`, `portOf` without the VLAN): two cake queues on one device. Refuse, or shape per VLAN.
- **Item pages by position:** `/firewall/rules/3` names a place, so a merge that inserts items can leave an open item page on another item.
- **New-item pages off the field kit:** the VPN provider, remote-access client and site pages are built by hand (their own flows: a pasted file, a key shown once, an invitation), their errors in an alert rather than on the field.
- **Equivalence corpus:** about a fifth of the seeded device × board outputs are errors, compared only as errors; generate intents that compile on more boards.
- **mwan3 recording:** `scripts/mwan3-test.sh` records `logread` without `-t`; record with it and drop `withEpochs` (`src/tests/helpers/logread.ts`).
- **Status on an invalid intent:** the Status pages go dark while the saved file fails a check, and this round added checks (root password, `dns.domain`, VLANs) an older file may fail. Status could compile the last valid settings instead.
- **A renamed item moves to the end** of its list after `merge3`, with no conflict reported: only its order changes.
- **A greyed value's reason** can be the ignoring rule's when another rule refuses it: say the refusing rule's first.

## Roadmap (2026-10-13)

- **App updates in status.** The Apply sheet now names an app update, a fix or a change on the device per line (`src/applyChanges.ts`, a stamp of hashes beside the intent, `<intent>.state/applied/`). Still to do: Overview says "not applied" when the current app would write something other than what the stamp holds, without opening Apply (a compile against stored facts, no device read).
- **Scheduled applies.** Apply at a time (overnight), router-hosted only (a Mac asleep would miss it): the plan reviewed now, its `verify` hashes kept with the job, and the run refused as `plan-stale` if a device changed before it starts; the result kept for the morning.
- **Apply history.** A list of past applies (when, what changed in the user's terms, how it ended, from the job records and `live.json` snapshots kept per apply), with Undo to any of them, not only the last.
- **Kept configs and sysupgrade.** `configs_to_not_reset` keeps (`luci.*`, `rpcd.*`, `ubihealthd`, LEDs, …) are never wiped, so they can drift or go stale, especially if a sysupgrade preserves `/etc/config`. Decide per keep: owned after all, regenerated, or explicitly unowned. An upgrade keeps settings and is applied once the devices are back (src/firmware/).
- **Onboarding.** A first-run wizard: find and add devices first (discover), read them, then either adopt their current setup (an intent suggested from what they run, with the coerced/unsupported parts named) or start fresh from a template, guided step by step, so nobody starts cold.
- **Firmware, still to do** (System › Firmware is built: `src/firmware/`, `provision --upgrade`):
  - **Verify on a real device, or in a rig:**
    - `sysupgrade` keeping settings, then the first-boot script standing aside (`/etc/onc/applied`);
    - a downgrade to an older series with `sysupgrade -f` and the on-device `/etc/dropbear` tarball, coming up on the first-boot defaults under the same host key;
    - a factory reset coming up on those defaults;
    - the router flashing itself and finishing at the collector's next start (its wait for netifd's `pending` to clear, its reinstall retried by uci-defaults);
    - the settings-kept flash writing the applied marker, and `clean` stopping a download left running.
    
    Checked so far on 25.12.5 in Docker: the device script's `room`, `fetch` (TLS from openwrt.org), sha256 check, `clean`, `keep-self` and its offline reinstall, `tar` of `/etc/dropbear`, and that `sysupgrade` takes `-f <tar.gz>`. Docker cannot run `sysupgrade` itself.
  - **The upgrade rig.** QEMU is on this Mac (Homebrew; `qemu-system-aarch64 -accel hvf` with OpenWrt's armsr/armv8 generic EFI image and `share/qemu/edk2-aarch64-code.fd`). The blocker is networking: user-mode (slirp) networking puts the VM behind NAT at 10.0.2.15, reachable only through a forwarded port, and the app assumes SSH on 22 (no port in a device's address). Either an SSH port per device (`hardware.*`/facts), vmnet (needs root on macOS), or a Linux CI runner with a tap bridge. The VM reaches ASU through the NAT, so fetching its image works. armsr's first boot has LAN static on eth0: give it two NICs.
  - **Upgrades done outside the app** (LuCI's Attended Sysupgrade, `owut`) on the router running it lose the app: the package could ship its own `/lib/upgrade/keep.d` list and `/etc/onc/`, though the package itself is still not reinstalled. A router-hosted app should say so in System › Firmware.
  - **Mesh depth in the flash order.** Mesh repeaters go first but in Hardware order, not deepest first (`meshOrder.ts`, as an apply orders them); one at a time with each back before the next, it matters only for which is stranded when one fails.
  - **Status during an upgrade:** Overview and the Apply sheet show the run as an apply; its firmware steps are shown only in the Firmware tab.
- **Status redesign, what is left** (`docs/design/status-redesign.md`, built 2026-10-17):
  - Check on a real access point: rpcd's `iwinfo assoclist` rates and generation, and `iwinfo survey`'s counters giving busy % over two reads (mt76 wraps them: the difference should hold).
  - Measure history, client history and the registry on a 128 MB router under QuickJS: file sizes, a cold read.
  - "Changed on <device>" marks only settings whose UCI lines record their setting (`origin.settings`); some (the time zone's `zonename`) have none yet, so a change there shows only in the Apply sheet.
- **More features.** Captive portal (guest network), ad blocking, scheduled firewall rules (block at times), people and device groups (James's iPhone and iPad off at 7 pm), more VPN options (servers, types), and a little more for OpenWrt power users.
- **Simple by default, advanced on demand.** Keep the intent and UI simple, with advanced panels that expand: every advanced setting has a sane default that is shown (and marked recommended) even when collapsed, so simple users never need them and power users can see and change what the defaults are, in the same UI.
