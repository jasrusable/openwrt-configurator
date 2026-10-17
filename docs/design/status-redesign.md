# Status redesign

The plan for rethinking what the app shows about the network as it runs.
Decided with the user on 2026-10-15; replaces TODO.md's "Status pages,
simpler". Items marked **verify** are assumptions to check on a device
before building on them.

## Who it is for

OpenWrt users and UniFi-controller types: technical, not network engineers.
They know dBm, channels, MCS, CGNAT and bufferbloat, and want the raw numbers
in view, under a verdict in plain words. Scale: a home or small office, at
most 8 routers and access points, 150 clients online, 500 remembered.

## Decisions

- **Status first, settings as a mode.** The app opens on status, and its
  sidebar holds only live pages. Settings is a mode of its own (one entry at
  the bottom of the sidebar, with its own list), and the mode boundary is the
  draft boundary: status shows what *is* and cannot be edited; settings edits
  the draft, which you review, apply, and then watch in status. Status and
  settings are never mixed on one page. This fits the project's aim: you
  declare the network once and then watch it run, so frequent editing would
  mean the abstraction had failed. Performance goes away.
- Every client and every device has a detail page (`/clients/:mac`,
  `/devices/:name`). Every count, node, row and attention item opens one.
- No composite "experience score". Show the raw values, coloured by fixed
  thresholds, and a "Poor" flag that names its cause.
- Hosting: the router first, but a Mac or a Raspberry Pi must work as well.
  History, events and the client registry are flushed to flash on the router
  (hourly, and when the service stops).
- Built for desktop first. Under 600 px, tables fold into two-line rows.
  Overview and the detail pages must work completely on a phone.
- Out of scope: kicking, blocking or waking clients; notifications; per-app
  traffic (DPI). Leave them out entirely, with no "not available" rows.

## Principles

1. **The verdict first.** Every page, card and detail page opens with one
   line saying how things are. Evidence comes next, then the detail, then the
   raw data (glance → page → item → raw).
2. **Status shows what is.** A setting appears only where it explains the
   state, or where the device differs from it, with an Edit link to it.
3. **One fact, one home.** A summary shows a fact and links to the page that
   owns it. No fact is repeated on the same page.
4. **Colour means state.** Green (good), amber (fair or warning), red
   (problem), grey (off, unknown, not watched). Band, client kind and role go
   in icons and text. Today's kind and band colours go.
5. **Time is first class.** Every key number has now, a 24 h chart and a
   30 d chart. Charts carry event marks (outage, failover, apply, reboot,
   roam), because that is how people find a cause. Gaps (nothing was reading)
   are drawn as gaps, never as good.
6. **Collections are tables.** Fixed, sortable columns; a row opens its
   detail page. Not `SettingRow`s with chips floating in the value slot.
7. **Precise words.** Name things as people say them ("Signal −67 dBm",
   "Channel 36 · 80 MHz · 42% busy"). OpenWrt's own term goes in the
   secondary text where it helps ("mwan3: online for 3 d"). Section titles
   say what is in them ("Channel survey", not "The air around").

## Shared vocabulary

| Measure | Good | Fair | Poor |
|---|---|---|---|
| Wi-Fi signal | ≥ −67 dBm | −67 to −75 | < −75 |
| Client rate (AP → client, while active) | ≥ 100 Mbit/s | 20 to 100 | < 20 |
| Channel busy (own channel) | < 30% | 30 to 60% | > 60% |
| Internet latency | < 30 ms | 30 to 80 | > 80 |
| Packet loss (bucket) | 0% | < 2% | ≥ 2% |
| Bufferbloat (added under load) | < +30 ms (A/B) | +30 to +60 (C) | > +60 (D/F) |
| Processor (per core, 5 min) | < 0.7 | 0.7 to 0.9 | > 0.9 |
| Temperature, memory, storage | as `views.ts` warns today | | |

A client is **Poor** when one of these holds, and the flag names it: weak
signal; low rate with a good signal (interference); busy channel; on 2.4 GHz
while an AP hears it well on 5 GHz (should move bands); a stronger AP hears it
10 dB better (sticky).

Line states stay as `lineState` has them (In use, Standby, Coming back,
Down), with the dot rule fixed: Standby is green when it works.

## Shared UI pieces (`ui/src/kit/`)

- **Verdict**: a state dot, one line, optional actions. It heads every page
  and card.
- **StatusTable**: sortable columns, a saved sort, filter chips, row → link,
  two-line rows under 600 px. Used by Clients, the device list, radios and
  events.
- **MetricChart**: 24 h / 30 d, a value axis with units, threshold bands
  drawn faintly, event marks (hover for the event), unwatched spans hatched.
  It replaces the 28 px sparklines that have no scale.
- **OutageStrip**: one cell per hour (24 h) or per day (30 d), green, amber
  (degraded), red (down), grey (not watched), with an uptime % that leaves
  out time not watched.
- **Freshness**: the page's "read 4 s ago" line stays. A section whose
  device did not answer says so itself ("Loft AP: last read 3 min ago").
- **SignalCell, RateCell, BusyCell**: the number together with its
  threshold colour, not bars alone.

## Information architecture

```
Status mode (default)                 Settings mode
  Overview    ▲2   /overview            ‹ Status
  Clients     37   /clients → :mac        Internet    /settings/internet
  Devices     ●    /devices → :name       Networks    /settings/networks
  Internet    ●    /internet              Wi-Fi       /settings/wifi
  Wi-Fi            /wifi                  Firewall    /settings/firewall
  Activity         /activity              VPN         /settings/vpn
  ─────────                               DNS         /settings/dns
  ⚙ Settings  •                           Hardware    /settings/hardware
  [Apply · 3 changes]                     System      /settings/system
                                          [Apply · 3 changes]
```

- The marks on status items stay quiet unless something needs you: the
  attention count, a red dot while the internet is down (amber on the backup
  line) or a device does not answer, System's update dot on Settings.
- Status → settings: every live value that a setting controls has "Edit ›",
  opening settings mode at that control. ⌘K searches every setting. Settings
  remembers the last page.
- Settings → status: a setting the devices do not match yet is marked ("not
  applied", "differs on the device"). Unapplied changes show in status mode
  as a banner with Review.
- Networks, VPN and DNS have no status page of their own: their live state
  is on Overview, the Internet page (DNS upstream) and the device pages, each
  linking to its setting.
- Onboarding (first run, Add hardware) opens in settings mode.
- Old routes redirect: the settings pages to `/settings/*`, `/performance`
  → `/internet`, `/hardware/*` → `/settings/hardware/*`.

## Pages

### Overview: is everything all right, and if not, what?

```
Overview                                        live · read 4 s ago
┌──────────────────────────────────────────────────────────────────┐
│ ● All good: internet 12 ms, no loss · 4 of 4 devices · 37 online │
│   or  ▲ 2 need attention                                          │
│       ▲ Loft AP is running hot · 86 °C               [Open]       │
│       ● Saved settings not applied                   [Apply]      │
└──────────────────────────────────────────────────────────────────┘
┌ Internet ───────┐┌ Wi-Fi ──────────┐┌ Devices ───────┐┌ Clients ───────┐
│ ● Fibre, in use │ │ 31 on Wi-Fi     ││ 4 of 4 up      ││ 37 online      │
│ 12 ms · 0% loss │ │ 2 poor          ││ warmest 61 °C  ││ 2 new today    │
│ ↓ 84  ↑ 12 Mb/s │ │ busiest: Loft   ││ 1 can update   ││ most: NAS 4 GB │
│ ▮▮▮▮▮▮▯▮ 99.9% │ │  5 GHz · 48%    ││                ││                │
└─────────────────┘└─────────────────┘└────────────────┘└────────────────┘
┌ Topology ─────────────────────────────────────────────────────────┐
│ Internet ─── Router · 12 ─┬─ cable 1 Gb/s ──── Office AP · 9       │
│                           └─ mesh 140 Mb/s ─── Loft AP · 16  ▲     │
└───────────────────────────────────────────────────────────────────┘
┌ Recent events ──────────────────────────────────── All activity › ┐
│ 14:02  Fibre down 40 s, Backup carried traffic                     │
│ 09:15  Settings applied to 4 devices                               │
└───────────────────────────────────────────────────────────────────┘
```

- Attention (which already includes "not applied", firmware and patches you
  can drop) is the verdict's list. "Not in your settings" becomes an
  attention item that opens the device it is on.
- Each card is a link to the page that owns it. Each topology node and link
  opens its device. A link shows cable/mesh, its speed, and amber below
  `weakMeshLinkMbps`.
- The topology is a tree built from each device's uplink setting, with mesh
  links as batman measures them. Unmanaged switches cannot be seen, so the
  map does not pretend to show cabling.
- Removed: the Networks, Wi-Fi, DNS and IPv6 sections (they repeated
  settings), the four tiles, the Mesh and VPN sections (moved to the device
  page and the VPN page), and the three repeats of internet state.

### Clients: who is on the network, and is anyone struggling?

Verdict: "37 online · 31 on Wi-Fi · 2 poor · 2 new today".

| Name | Network | Connection | Signal | Rate ↓/↑ | IP | Traffic (month) | Seen |
|---|---|---|---|---|---|---|---|
| ⌂ Jason's iPhone | Home | Loft AP · 5 GHz | −58 | 866/433 | 10.0.0.23 | 12.4 GB | now |
| ▢ Living room TV | IoT | Cable · Office AP | — | — | 10.0.20.8 | 41 GB | now |

- Filter chips: Online · All · New · Poor · Private address; Network; AP;
  Band. Search covers name, MAC, IP and model.
- The kind icon is grey, in one colour (colour means state). A row
  that is Poor carries an amber cell plus its cause on hover.
- **New** means first seen within 24 h. A MAC with the locally administered
  bit set is shown as "Private address" and never counted as new.

**Client page** `/clients/:mac`:
- Verdict: "● Good · Loft AP · 5 GHz · −58 dBm · 866 Mbit/s", or the Poor
  cause with what would help ("A stronger AP, Office, hears it at −52").
- Identity: name (yours, else mDNS, else DHCP), kind and model, MAC and its
  maker, private address or not, IPv4, IPv6, network, fixed address or not
  (Reserve stays, as a draft edit), first seen, last seen.
- Connection now: AP, SSID, band, channel, signal, rates, Wi-Fi generation,
  connected for. Cable: which device and port, where known.
- 24 h charts: signal (with each roam marked) and traffic.
- Which APs hear it (usteer), the one it is on in bold.
- Its events: joined, left, roamed, got an address.

### Devices: are the routers and access points healthy?

A StatusTable: name, role, model, OpenWrt, state, uptime, processor, memory,
temperature, clients, uplink (cable/mesh and speed), update. A row opens
the device page.

**Device page** `/devices/:name`, with "Hardware settings ›" linking to the
device in Settings › Hardware:

```
Loft AP  · Access point · GL-MT6000 · OpenWrt 25.12.5        [··· actions]
● Up 6 d · 16 clients · mesh to Router 140 Mb/s
┌ Health ──────────────────────────────────────────────────────────┐
│ Processor 0.31/core  ▁▂▁▃▂▁   Memory 41%  ▁▁▁▁   Temp 61 °C ▂▃▃▂ │
│ Storage 82 MiB free                                     24h | 30d │
└──────────────────────────────────────────────────────────────────┘
┌ Ports ───────────────────────────────────────────────────────────┐
│ [wan 1G ●] [lan1 1G ●] [lan2 —] [lan3 100M ▲]    ↓↑ per port      │
└──────────────────────────────────────────────────────────────────┘
  Radios      (table: band, channel/width, busy %, noise, power, clients)
  Mesh        (links: to, measured speed, last seen, MTU warnings)
  Clients     (the Clients table, filtered to this device)
  Services    (declared ones, running or not, Restart where allowed)
  Firmware & fixes   (release, target, patches active here)
  Not in your settings   (interfaces, SSIDs: removed on the next apply)
  Events · System log (raw logread, filtered by the expert)
```

- The rings go: each metric is a number plus a 24 h chart.
- A port at 100M where it negotiated 1G before is amber (a bad cable).
- Actions: Ping…, Traceroute…, Restart Wi-Fi…, Reboot…. Speed test is on
  Internet.

### Internet: is the line good, and was it?

```
● Fibre in use · 12 ms · 0% loss · up 3 d
┌ Lines ───────────────────────────────────────────────────────────┐
│ Fibre   ● In use   203.0.113.7 · 2001:db8:12::/56 · gw 203.0.113.1│
│         DHCP · wan on Router port wan · mwan3: online 3 d          │
│ Backup  ● Standby  100.64.3.2 (CGNAT) · LTE                       │
└──────────────────────────────────────────────────────────────────┘
┌ Uptime ──────────────── 24 h | 30 d ┐  ▮▮▮▮▮▮▮▮▮▮▯▮▮  99.92%
┌ Latency and loss ──────────────────┐  gateway ─ internet ─ loss bars
┌ Throughput ────────────────────────┐  ↓ ↑, with the line's speed drawn
┌ Speed test ─────────────────────────────────────────── [Run test] ┐
│ 14 Oct 21:04  ↓ 912  ↑ 108 Mbit/s  · under load +18 ms  (B)        │
│ "As fast as Router can measure: its processor may cap it."         │
└──────────────────────────────────────────────────────────────────┘
  Public address  203.0.113.7 · behind another NAT: no
  DNS             answering · upstream: Cloudflare (DoH) · fallback idle
  Smart queueing  on · keeping latency down under load: +18 ms vs +240 off
```

- Latency to the gateway as well as to the internet separates "my ISP's
  line" from "the internet past it".
- A failover is marked on every chart. The outage strip uses mwan3's state
  where it runs, else the collector's probe.
- Smart queueing is shown by what it does (latency under load), not by the
  number of packets it dropped.

### Wi-Fi: is the air good, and are clients well served?

- Verdict: "31 clients · 2 poor · busiest: Loft 5 GHz 48%".
- **Radios** table: AP, band, channel/width, generation, busy %, noise,
  power, clients, with a 24 h chart of clients and busy % per radio.
- **Channel map**, per band: channels across; each of your radios as a block
  as wide as its width; neighbours from the last survey faded under it;
  overlaps highlighted. Survey on request stays, with the warning that
  clients notice a short pause.
- **SSIDs**: each one on air where, and its clients by band.
- **Needs a nudge**: sticky clients and clients on the wrong band (the Poor
  causes), each opening the client.
- Impostors (your SSID from a radio that is not yours) are an attention item.

### Activity: what happened, and when?

- Events from the collector (below), not filtered syslog: one wording, they
  survive log rollover, and they are the same for every host.
- Kinds: line down/up, failover, device lost/back, reboot, apply
  (started/ended, how), radio down/up, mesh link lost/back, new client,
  service stopped. Client joins, leaves and roams are too noisy for this
  feed and appear only on the client's page.
- Filters: kind, device, time range. Each event links to its subject.
- The raw system log moves to each device page.

## Backend additions (built, phase 1)

What the device facts decided, checked against OpenWrt 25.12's sources and,
where possible, run in its rootfs or read from the real access point's
recording (`src/tests/helpers/status/`):

### Probes (`src/status/device/`)

| Addition | Source | Why this way |
|---|---|---|
| Client rates, Wi-Fi generation, connected time | rpcd `iwinfo assoclist` per interface (rates in kbit/s, `ht`/`vht`/`he`/`eht`) | hostapd's own `rate` is in tens of bit/s in 25.12 (its driver already turns nl80211's 100 kbit/s into kbit/s, ubus.c multiplies by 100 again: the real AP's 7220000 is HT MCS 7's 72.2 Mbit/s), it has no EHT flag and no connected time. rpcd-mod-iwinfo comes with `luci-ssl` on every role. |
| Own channel's busy % every read | rpcd `iwinfo survey` (passive, no scan), the entry on the radio's own frequency | rpcd has no in-use flag (the survey action never marked "yours": fixed by frequency). The counters run on; busy % is the difference between two reads, in the collector, which holds where mt76 wrapped them (both of the real AP's in-use channels were). |
| Loss, jitter, latency to the gateway | four pings each, to 1.1.1.1 and to the default route's next hop, a second apart; jitter from successive replies | busybox's `ping -i` takes whole seconds only, and prints no mdev. |
| WAN details | `network.interface dump`: `proto`, the default route's `nexthop`, `ipv6-prefix` (on wan6), `dns-server` | free: already read. |
| Each DoH instance answering | `nslookup -port=<port>` to the provider's (5053) and the fallback's (5054) | https-dns-proxy has no health method. |
| Speed test up as well as down, latency under load, kept | eight seconds each way: downloads sized from the speed so far, uploads of 1 then 2 MB (uclient-fetch `--post-file`), pings throughout; the last 50 kept | a fixed size took under a second on a fast line (one ping's worth); uclient-fetch holds a whole body and a third of 4 MB uploads stalled (10 MB always). Grade by added round trip: A < 5 ms, B < 30, C < 60, D < 200, F. |

### Events (`src/status/events.ts`)

`observe(status, at, previous)` keeps what the next read needs;
`eventsBetween(before, after)` says what changed, oldest first. A line's
time comes from mwan3's time in its state, or its interface's uptime, so a
drop between reads is told ("dropped and came back"). A device is lost after
two missed reads, and only if it answered since the collector started; a
restart is told from its uptime (back with an uptime shorter than its
silence, or answering both times with its clock started again). Also:
failover and back, services stopping and running again, ports connecting,
disconnecting and slowing, SSIDs off the air and back, mesh links lost and
back, a new client, this app's applies. Kept 30 days, at most 5,000; the
snapshot carries the latest 200, `GET /api/events[/<since>]` the rest. Client
joins, leaves and roams are not events.

### Client registry (`src/status/registry.ts`)

Per MAC: first and last seen online, last name, kind, model, address,
network, AP and band. Forgotten after 30 days unseen unless reserved; at
most 500. Everyone online when remembering began is not new; new is first
seen within a day, never a private (locally administered) MAC. The client
list carries the registry's away clients too.

### History (`src/status/history.ts`)

- Day (1 min) and 30 days (15 min), as before, plus: gateway latency, loss,
  jitter, `internet` and `line:<id>` (1 up, 0 down: a point's mean is the
  share it was up, the outage strip's cells), memory per device, clients
  and busy per radio (`clients:<ap>:<band>`, `busy:<ap>:<band>`).
- Per client, a day at 10 minutes: signal, the AP's rate to it, its traffic
  down and up (from the router's nlbwmon counts between reads).
  `GET /api/clients/<mac>` gives one client's, with its registry entry.
- A point that is not there was not read: charts break there and uptime
  leaves it out. No separate record of when the collector ran.

### Persistence

Router: live in RAM (`/tmp/onc-collector`); history, client history, events
and the registry are copied to the intent's state directory (flash) every
hour and as the service stops (`platform.onStop`), and taken back at start
where RAM has none. Mac and Pi: written beside the intent, as before.

## What moves or goes

| Today | Goes to |
|---|---|
| Overview tiles, Networks/Wi-Fi/DNS/IPv6 sections | removed; the cards, and DNS on the Internet page |
| Overview Mesh section | device page › Mesh; topology links |
| Overview VPN section | the router's device page, a VPN section |
| Performance › internet | Internet |
| Performance › radios, survey, roaming | Wi-Fi |
| Devices page | Devices, then the device page |
| Every settings page | settings mode, under `/settings/*` |
| Activity's logread lines | events; the raw log on each device page |

## Phases

All six built on the `status-redesign` branch (2026-10-17), tests first
(parsers on recorded output, events, the registry and health as pure
functions), each page looked at in the preview (`scripts/status-preview.ts`),
desktop and phone.

1. **Data**: probes, events, the registry, history, persistence, the API.
2. **Kit**: `src/status/health.ts` (tones and thresholds, a client's causes),
   `ui/src/kit/status.tsx`, `StatusTable`, `TimeChart`, `OutageStrip`.
3. **Clients**: the table and the client page.
4. **Devices**: the list and the device page (with the router's networks
   and VPN peers, as Overview's sections were).
5. **Internet and Wi-Fi**; Performance removed, with redirects.
6. **Overview, Activity and settings mode**: the two sidebars, settings
   under `/settings/*` with every old address redirected, attention linking
   to the live thing (an unreachable device to its page).

Changed from the plan while building, for reasons found then:

- A client's link rate is shown, never judged: an idle link drops to 1 or
  6 Mbit/s at any signal (the real AP's recording). "Needs a look" counts a
  poor client or one with something to do (a better AP or band, a crowded
  channel), not a fair signal alone.
- No separate record of when the collector ran: a point not there is a gap.
- More than four series on one chart would break the colour rule: each
  radio's air is a small chart of its own.

Built after (2026-10-17, second pass):

- ⌘K (`ui/src/Finder.tsx`, `findable.ts`): every setting by label,
  description or OpenWrt name, once per item it is for, only where its part
  is set, never a value; pages, devices, clients. A setting opens its page at
  its row: `?at=<path>` (`settingUrl`), found by `data-setting` on
  `SettingRow`, scrolled to, marked and focused (`form/landing.ts`), else
  the nearest setting holding it.
- Edit › (`kit/status` `EditLink`, a `Facts` item's third part) on the
  client, device, Internet and Wi-Fi pages, where a value comes from one
  setting; tables get one in the panel's header.
- Settings rows marked (`form/fields/applied.tsx`): "Not applied" (saved,
  against `live.json`, after a first apply) and "Changed on <device>" (the
  cached change plan's drift lines, whose settings `PlanItem.settings` now
  carries; a row never starts a device read).
- Traceroute (busybox, UDP: `-n -q 2 -w 1 -m 16`, 32 s at worst), from a
  device's actions.
- A client's joins, leaves, roams and band moves (`src/status/moves.ts`):
  per client, the latest 30 for 7 days, `client-moves.json`, on its page and
  as marks on its signal chart; gone only after two missed reads.

Not built yet (TODO.md):

- Measuring the history's size and a read's time under QuickJS on a router
  with 128 MB.

## Open risks

- Per-client history and the registry on a router with 128 MB RAM:
  measure before committing to the budgets.
- A router's own speed test is capped by its processor; say so beside the
  result rather than pretending it measures the line.
- Events only see as finely as the reads; anything shorter than an interval
  is caught only where a device keeps a state time.
- Settings mode adds a click to editing; Edit › links, ⌘K and remembering
  the last settings page are what keep it cheap.
