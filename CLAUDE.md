# CLAUDE.md

Guidance for Claude Code when working in this repository: the rules, then a
map. Detail lives next to the code it explains (comments) and in the tests
that guard it; this file says where.

## Never read secrets from config files

**This is the highest-priority rule in this file. It overrides convenience, debugging, and "I just need to see the shape of it."**

Real network config files in this repo may still contain live credentials: SSH root passwords (`provisioning_config.ssh_auth.password`), Wi-Fi PSKs (`key` on `wifi-iface` sections), PPPoE credentials (`username`/`password` on `interface` sections), and DDNS/VPN tokens. An intent file holds them as plain values (it is owner-only, mode `0600`); `{ "$secret": "wifi/home" }` refs (resolved from the macOS keychain at load) are for hand-written low-level files only, and an intent holding one is refused.

Do **not** open, `cat`, `grep`, print, or otherwise pull the contents of:

- `*.config.json` at the repo root (e.g. `stellenberg.config.json`) — gitignored, mode `0600`, real.
- Anything under `configs/` — gitignored, and a separate nested git repo of the user's live network configs.
- Any file the user points at as "my config" / "my network config", wherever it lives.

If you need to understand config *structure*, use the committed fixtures instead — they contain only placeholder secrets:

- `sampleConfigs/basic.json`
- `src/tests/main/config.json`, `src/tests/main/config2.json`
- `README.md` (the low-level config's keys, with examples)

If a task genuinely cannot proceed without something in a real config file, stop and ask the user to paste the specific non-secret value. Never dump the file to find it.

Corollaries: don't echo a secret you happened to encounter, don't write one into a test fixture, commit message, log line, or scratch file, and don't add code that logs `ssh_auth` or wireless `key` values. Do not resolve `$secret` refs or pass `--show-secrets` just to inspect values. Do not dump UCI `wireless`/`network` password fields off a live device either — after provision those values live in UCI because OpenWrt needs them.

## Never provision without being asked

`provision` connects over SSH to real routers and access points and rewrites their UCI config. A bad config can drop the network or lock the user out of a device mid-run.

- Never run `npm run provision`, `build-images` (non-dry-run), or the built binary against real devices unless the user explicitly asks in that message.
- `print-uci-commands` is read-only *on the device*, but it still opens an SSH connection to introspect it (see "Facts" under "Architecture"). Treat it as a network action, not a local one.
- The only fully offline commands are `npm test`, `npm run build`, and `build-images --dry-run` (which only reaches out to the OpenWrt ASU API for profile resolution, and tolerates that failing).

## What this project is

One JSON file describes a whole home network; the app provisions it to
OpenWrt routers and access points over SSH, with commit-confirm rollback. The
normal input is an *intent* file (decisions in the user's terms: networks,
Wi-Fi, internet lines, VPN, DNS, devices by role), edited in a web UI (Node on
a Mac, or a QuickJS CGI on the router) and compiled per device. A hand-written
low-level JSON format (UCI-like, `.if`/`.overrides`) is still accepted at the
CLI edge. Shipped as `pkg` binaries, a QuickJS bundle, an OpenWrt feed and a
Homebrew formula.

## Open work

Tracked in `TODO.md` at the repo root. Add to it what is found and deferred, and remove an item in the commit that finishes it.

## Commands

```sh
npm test                 # ava; all offline
npm run test:watch
npm run build            # tsc -> ./dist (excludes *.test.ts)
npm run typecheck        # tsc over src, bin and the tests
npm run bundle           # QuickJS bundle -> dist/qjs (scripts/bundle.js)
scripts/rig-test.sh      # end-to-end provision against OpenWrt in Docker, ~1.5 min
npm run equivalence -- [<git-ref>] [--state]
                         # a refactor's guard: every device's script (or, --state, its
                         # engine state) for seeded intents × captured boards, against
                         # <git-ref> (default HEAD); changes made on purpose are listed
                         # in scripts/equivalence.expected.json (--expect <file>)
npm run package          # pkg -> ./artifacts (needs npm run build first)
npm run ui -- <intent>   # build the web UI and serve it on http://127.0.0.1:8080
npm run dev -- <intent>  # the same, with hot reload: UI rebuilds and reloads, backend restarts

# Against real devices — only on explicit request:
npm run provision          <config-file>
npm run print-uci-commands <config-file>   # the plan's summary, then each script
npm run provision -- <intent> --plan        # the change plan only: reads devices, applies nothing
npm run build-images       <config-file> [--dry-run] [--out ./images] [--concurrency 3]
npm run provision          <intent> --upgrade <devices|all>   # firmware first, then apply
```

Node 24 (`.node-version`), TypeScript 6, CommonJS. Devices must run **OpenWrt 25.12 or later** (or a snapshot): the engine drives apk, and `src/release.ts` refuses an older release before planning, in `provision` and `print-uci-commands` (not `capture-device-schema`). Supporting older releases would be an engine change (detect apk/opkg live, map logical package names per release, an opkg path for offline rollback), not a compiler one; package names currently live in the compiler's features. `ts-node --transpile-only` for the dev scripts, so type errors do **not** surface there — run `npm run build` to typecheck.

## Architecture

Dependencies point one way: **intent → plan → engine → apply → agent** (on
the device), with **facts**, **status**, **store**, **server** and **cli**
around them, and everything reaching the runtime only through a
**platform**.

### Entry points and the CLI — `bin/`, `src/cli/`

`bin/index.ts` (Node) and `bin/qjs.ts` (QuickJS) build a platform and call
`run({ argv, platform })`. `src/cli/` holds one file per group of commands
(`config`: compile, print-uci-commands; `provision`; `serve`: ui, cgi,
collect; `images`; `schema`; `secrets`), parsed by `src/args.ts`.
`src/loadConfig.ts` reads a file (JSONC, `src/parseJson.ts`), resolves a
low-level file's `$secret` refs (`src/secrets/`: macOS keychain, else
`/etc/onc/secrets.json`; an intent holding one is refused: intents are plain),
compiles an intent or reads a low-level file, checks the plan once, and
returns a `Result` with a `Problem` (`loadConfigOrThrow` for CLI and tests).
Secrets are hidden in everything printed unless `--show-secrets`
(`src/secretOptions.ts`: by option name and owner-only file content, plus any
`$secret` value; the apply diff uses the same rule).

### Intent — `src/intent/`

- One folder per feature (`system`, `hardware`, `internet`, `networks`,
  `wifi`, `mesh`, `firewall`, `vpn`, `dns`), each with `schema.ts` (its
  slice), `checks.ts` (cross-field), `rules.ts` (what a setting may be given
  the rest, and why not), `fields.ts` (labels, explainers, LuCI names),
  `constants.ts`, `compile.ts`, and `index.ts`: its one public surface, a
  `FeatureModule`. Nothing imports a feature except through its index.
- The root assembles: `schema.ts` (the intent's zod schema), `modules.ts`
  (the one feature list; order decides compile order and whose rule wins),
  `choices.ts` (rules, `availability`), `fields.ts` (`fieldInfo`,
  `explainFor`), `compile.ts` (`compileIntent`, pure). Shared helpers stay at
  the root (`fragment.ts` conditions, `names.ts`, `site.ts`, `access.ts`,
  `connections.ts`, `radios.ts`, `addresses.ts`, `edits.ts`, `merge.ts`,
  `diff.ts`, `places.ts`, `labels.ts`). `patches/` holds fixes and tunings
  over stock OpenWrt, one file each (see "A fix over stock OpenWrt" below).
- Rules and fields are keyed and typed by `SettingPath` (`paths.ts`); a
  mistyped path or value does not compile. The UI's draft uses the same types.
- Invariants:
  - The intent holds decisions only, never device facts; validity never
    depends on which device is plugged in.
  - No escape hatch: the features plus their defaults must make a complete
    working device, because the wipe removes everything not declared.
  - Packages are fixed per role, never chosen by a setting; "off" is config
    written disabled, checked against the package's init defaults, and an
    unused service is declared off (`serviceWhen`).
  - Sections built from lists are named for what they are, never their place
    (`names.ts`), so adding or reordering renames nothing.
  - Derived ids (ULA prefix, mesh id, UPnP UUID) grow from `siteSeed`
    (`system.site_id`, kept on rename by `keepSiteSeed`).
  - The format stays at `schema: 1` with no migrations until the first
    release: change it freely and hand-edit files. The chain
    (`migrations.ts`, n → n+1, in memory wherever a file is read; a newer
    format refused) is in place and empty.
  - A pinned or mesh channel is one the country allows: `radios.ts`'
    `channelLegal` over wireless-regdb (`wifi/regdb.ts`, generated by
    `scripts/gen-regdb.js`, NO-IR ranges left out as an AP cannot beacon
    there); choosing a country that would strand a pin is greyed out.
  - DNS over HTTPS has a fallback provider (`dns.upstream.fallback`,
    automatic by default), asked only while the provider does not answer;
    a network may keep its devices on the router's DNS (`networks.*.keep_dns`:
    redirect, DoT refused, the Firefox and iCloud canaries), refused where its
    devices are given other servers. A WireGuard peer dialled by name puts
    `wireguard_watchdog` in root's crontab, a file this app then owns whole.
  - Root's password is `system.app_login.password`, set on every device;
    password login off needs a key, and an apply that would lock this app
    out is refused first (`src/loginAccess.ts`).

### Plan — `src/plan/`, `src/lowLevel/`

The typed value the compiler produces and the engine applies
(`plan/types.ts`): devices, packages `{ add, remove }`, services, files,
keeps `{ config, type?, optional? }`, and sections
`{ name?, when?, options, overrides? }`. Conditions are trees (`when.ts`),
placeholders typed values (`linePort`, `cpuPort`, `switchName`,
`freePorts`, `bridgePorts`, `eachBridgePort`, `allRadios`, `spareRadios`,
`bestMode`, `stations`), and
`positions.ts` says where each may stand. `check.ts`/`rules.ts` validate any
plan. `src/lowLevel/` reads and prints the hand-written JSON (snake_case keys,
`.if` strings via `src/condition.ts`, placeholder strings like `@wan_port`,
`"*"`, `"*t"`); print then parse is the identity, and text that looks like a
placeholder prints with a second `@`.

### Engine — `src/engine/`, `src/getDeviceScript.ts`

Per device: `resolvePlan.ts` (conditions against the device, overrides
merged) → `getOpenWrtConfig.ts` with `ports.ts`, `radios.ts`, `values.ts`
(placeholders fitted to the facts: WAN/line ports, free ports, DSA
`bridge-vlan` vs swconfig `switch_vlan` on the board's own switch name,
radios by band, a band's channel and single-interface mesh on the radio
whose channels hold it (tri-band; else the band's first), best `htmode`) →
`getOpenWrtState.ts` (config, packages, keeps, services, files) →
`getUciCommands.ts` and `uci.ts` (the UCI text model, `declaredConfigs`,
`verifyConfigs`, `changedConfigs`). `uciOrder.ts` keeps the order configs and
options have always been written in: change it and every service reloads on
the next apply. `getDeviceScript.ts` turns a state into the agent's records
and renders the dry run. The engine never names a package and never parses a
condition.

### Apply — `src/apply/`

`provisionNetwork.ts` runs every device as one change: plan → stage the
rollback (packages fetched for all before any arm) → arm → configure → commit
→ confirm all → disarm all → hooks → services check. Each phase is a module
returning a `Result` (`run.ts`: `DeviceRun`, `guarded` turns any throw into a
failure that says what it left: committed, left armed). The run returns a
`RunResult` (`outcome.ts`); `cli/provision.ts` maps it to exit codes (3:
applied, a later step failed). `reconnect.ts` reconnects and waits for procd
to settle; `provisionConfig.ts` connects and orders devices (the local
device, then the gateway, then the access point this machine is on by Wi-Fi
last, `gateway.ts`; mesh repeaters deepest first: `meshOrder.ts`).

The plan refuses, before anything changes: a declared config the device
lacks that OpenWrt does not ship (`knownConfigs.ts`) and the file does not
list in `new_configs` (a typo would stage its own config while the real one
is wiped); and packages that would not fit the flash (`apk add --simulate`
totals against the overlay's free space, `packageSpace`). It also reads
which configs each service's procd reload triggers watch: the agent's
`services` step restarts a declared service with none for its config when
this run changed it (finalise lists the changed configs by
`reload_config`'s own md5 test). Given a reviewed plan's `verify` (each
device's `stateHash`, `src/deviceState.ts`: config lines with secrets left
out, packages, managed files), planning re-reads it and refuses a device that
differs as `plan-stale` (a `RunEnd` and an outcome), before anything is
staged or armed; without one (the CLI) nothing is checked.

### The change plan — `src/applyPlan.ts`

What an apply is reviewed by, in the UI and the CLI alike. `applyDiff.ts`
reads each device (`readDeviceNow`) and diffs it against what the apply
leaves, each line classed (`applyChanges.ts`) as an edit, an app update, a
fix (`fixSources`) or a change on the device, told apart by the last applied
settings compiled today and a stamp of hashes the last apply left
(`<intent>.state/applied/`, never a value); `applyImpact.ts` says what each
change is noticed as (25.12's hostapd.uc: a radio option restarts the radio,
a network's only that network) from small `ImpactFacts`. `buildApplyPlan`
(pure) makes `{ readAt, items, devices, unread, summary (verdict, ~min,
blocked), needs (devices dropping off, drift to replace, flash), verify }`, items ordered most
noticed first with uci lines grouped by config in `uciOrder`'s order, then
renames, packages, files. Served at `GET /api/apply/plan`, printed by
`provision --plan` and atop `print-uci-commands` (`applyPlanText.ts`).

### Firmware — `src/firmware/`

System › Firmware. The network picks a release (`system.firmware.release`): `stable` (Latest OpenWrt, any series), a series (`25.12`: its newest), or one release. Each device follows it, holds, or is pinned (`hardware.*.firmware`); its row in the tab and its Hardware page edit the same value. Where each stands is pure (`target.ts`), from the draft, the facts and ASU's overview (`releases.ts`: asked once a day by the collector, the last answer kept offline). Release candidates and snapshots never count.

`provision --upgrade <devices|all>` (the UI's `POST /api/firmware/upgrade` starts the apply job with it) upgrades first, then applies the saved settings:
- **Plan** (`upgradePlan.ts`): devices behind, access points first and the router last (the device this app runs on last of all). A downgrade, or a move into a series newer than `newestCheckedSeries`, is refused unless acknowledged (`--accept-downgrade`, `--accept-new-series`).
- **Builds** (`builds.ts`): one image per board, role and release, all requested from ASU before anything flashes. An image holds the role's packages and the first-boot script (`firstBoot.ts`): per role, no hostname, no MAC, nothing secret (`firmwareBuilds.test.ts` checks generated intents). `build-images` on an intent downloads them into `<intent>.state/images/` by hash.
- **Flash** (`upgrade.ts`, the device script `upgradeScript.ts`): each device fetches its own image from ASU into its RAM (never through this machine), refused first if RAM is short, checks the sha256 and `sysupgrade -T`, and removes it on any failure. Settings are kept, except back to an older series: then only `/etc/dropbear`, from a tarball made on the device (`sysupgrade -f`). The run waits for the new release before the next device.
- **The device this app runs on** (`self.ts`): it keeps its own `.apk` and a one-shot offline reinstall through the upgrade (keep.d), notes the release, and the collector's next start finishes the run.
- **A confirmed apply** writes `/etc/onc/applied` (kept by keep.d): the first-boot script then leaves an upgraded device's settings alone. A reset device has a new host key: Hardware offers to take it back under its own name if its MACs match (`inspectReset`, `readopt`).

### Agent — `src/agent/`

One fixed POSIX sh script (`script.ts`, its verbs and lessons in its header
comment), written once per run to `/tmp/onc-agent-<runId>.sh`; every step on
the device is a verb with data on stdin (`records.ts`), never argv.
`paths.ts` is the device-side contract other code reads (the mesh rescue
watcher). `index.ts` calls verbs and returns `Result`s.

What an SSH session must not hold: each verb first moves itself out of
dropbear's cgroup (into `/sys/fs/cgroup/onc`, else the root one), as a
process left in it keeps procd from starting a stopped dropbear again (seen
on SNAPSHOT); a command that may leave a process running (apk, `run_after`,
hooks, service starts) runs `detached`, its output passed on after, never
the channel's own streams, which a leftover process would hold open; and
`say` waits at most 2 s on the system log, as a wedged logd blocks writers.

### Facts, status, store — reading devices

| Plane | What | Owner | Stored |
|---|---|---|---|
| Config | what devices should be | intent → compile → apply | the intent file (the only plane that writes) |
| Facts | model, release, ports and the switch's name, radios (their modes, mesh ability and channels: nl80211 through ucode), MACs, host key | `getDeviceSchema.ts` probes, `facts/board.ts` parses | `<intent>.state/devices/` (`deviceFacts.ts`) |
| Status | what devices are doing | `status/device/` probes, `status/views.ts`/`network.ts` interpret | the collector's snapshot and history |

- Facts describe hardware and never decide; the compiler never sees facts or
  status. They may grey a UI choice, never refuse it.
- Finding a device (`locate.ts`) fails closed: only the address the settings
  give is trusted on first use; any address the app found itself is tried
  only with a pinned host key, held by the SSH client. New devices come in
  through Hardware › Add (`discover.ts`), by IP address only (a name can be
  claimed in DHCP), its host key's fingerprint shown as `dropbearkey -y`
  prints it (`sshFingerprint.ts`) to compare before trusting it.
- `status/collector.ts` owns device reads for the Status pages: every 10 s
  while someone looks (a `wanted` mark), once a minute otherwise, never during
  an apply; `/api/status` answers its snapshot. On a router it runs as the
  `onc-collector` procd service, writing to RAM. It keeps the settings
  compiled between reads (`readStatusSettings`: loaded again only when the
  file changes, a device's state only when its facts do; 32 ms a read cold,
  0.4 ms warm under QuickJS). Graphs: a minute's points for a day and 15
  minutes' for 30 days (`status/history.ts`, `/api/history[/month]`).
- Clients are named by what they say over mDNS (the router's umdns, read
  after asking for a fresh look at most once a minute: a look drops the cache
  for a few seconds) unless you named them, and typed (`clientKind.ts`) from
  that model, their services, their name and a few makers. The wired mesh is
  read where it runs: `br-lan.4000` on DSA, the CPU's `eth0.4000` on swconfig
  (`meshWiredLink`).
- Actions (`status/actions.ts`) run only on request, one at a time, within
  the CGI's 60 s, refused during an apply: restart a declared service, reboot
  a device, restart its Wi-Fi, ping from it, speed test, Wi-Fi survey. Ones
  that cut the link (reboot, Wi-Fi) start detached a moment after answering;
  a reboot is kept (`rebooting.json`) so status says "rebooting" until the
  device answers with a fresh uptime (ten minutes at most). Status reads use
  root over SSH; a read-only rpcd login was designed and left out (TODO.md).
- `store.ts`: every file under `<intent>.state/` (paths from `stateLayout`;
  its directories 0700, an old 0755 one tightened), each a key with a zod
  schema, format and mode, written atomically and owner-only; old formats read as nothing unless upgraded. Facts keep their
  pins (address, MACs, host key) across format changes.
- Expected failures are `Result<T, Problem>` (`result.ts`, `problem.ts`: a
  kind plus typed extras); throwing is for bugs.

### Server — `src/server/`

`app.ts` gates every request (frame headers, `X-ONC`, login on a router)
over `router.ts` (routes as data; `respond`/`problemResponse` map a
`Problem` to a status) and one module per area in `api/`. `onc ui` serves it
with Node, loopback only, no login; `onc cgi` answers one request under
uhttpd (`cgi.ts`). `provisionJob.ts` starts an apply as a detached
`provision --job --run-id` process (`--verify` when the start carried a
plan's hashes) and reads its record (alive while its pid
has its run id on its command line). Its events (`applyEvents.ts`) give each
device's step and, once armed, the `window` (confirm by, restored by at the
latest) the Apply sheet counts down. The sheet (`ApplyModal.tsx`, a Mantine
Modal) has three states, each replacing the last: the review (`Review.tsx`:
verdict, acknowledgements gating Apply, by change or by device, up to date
with "Re-apply anyway"; a `plan-stale` end brings it back, read again), the
run (`RunProgress.tsx`), and the result with Undo of the last apply
(`RunResult.tsx`, `UndoSection.tsx`). Every change row is `ChangeRows.tsx`. An applied run keeps the live intent it replaced as
`live.previous.json` (times in `provision.applied.json`);
`POST /api/provision/undo` applies it again under an apply's lock and
lockout checks, the saved intent untouched unless `restoreSettings`. The UI (`ui/`, React + Mantine) edits
the intent file and nothing else; `ui/src/data/` is its only HTTP code.
System › Backup (`src/backup.ts`, `api/backup.ts`) downloads the file as
stored and replaces it with a backup, the defaults (`intent/starter.ts`,
keeping the devices, addresses and login) or, with none saved, a new
network (the first-run screen): each reviewed first (migrated, checked,
its changes listed; a backup with `$secret` refs refused), the file it
replaces kept as `<intent>.bak` (`writeIntentFile`, also on a save over an
older format).

### Platforms — `src/platform.ts`, `src/platforms/`

Nothing outside `src/platforms/` imports a Node built-in or touches
`process` (`platformBoundary.test.ts`). One bundle runs under Node and under
QuickJS on a router (`qjsGlobals.ts` first; SSH as a spawned `dbclient` or
OpenSSH per command, exit status from a marker; local mode runs commands with
`sh -c`). Functions take only the `Pick<Platform, …>` they use.

Every command on a device ends by a time limit (`commandTimeoutMs`, 2 min;
longer for package steps and hooks, per agent verb): QuickJS kills the
client, Node closes the connection, and the answer says `timedOut`, which
the agent reads as "unreachable", so the phases roll the device back rather
than wait. A stalled dbclient once held a rig run forever
(`provisionNetwork.test.ts`, `commandTimeout.test.ts`, the QuickJS session check).

## Contracts worth knowing before changing the apply path

- **The wipe.** Every run leaves each device's UCI config exactly as
  declared, except what keeps (`configs_to_not_reset`) hold. Configure reads
  every config after prepare (packages change configs), stages the wipe and
  the declaration in one `uci batch`, reads back and verifies; any difference
  reverts with nothing committed (`verifyConfigs`).
- **Order on the device.** Revert every pending change (whoever made it) →
  seed owned configs → packages → `reload_config` (the change baseline,
  before any staging) → stage → files (before commit) → commit by name →
  `reload_config` → services over the first reconnect → hooks over their own
  session. Why each is where it is: the agent's comments.
- **Commit-confirm.** The watchdog restores unless confirmed in
  `--confirm-timeout` (90 s, minimum 60) per device; confirming waits for
  procd to settle and reconnects again; all devices are confirmed before any
  is disarmed. `ONC_TEST_MIN_CONFIRM_WINDOW` is for tests only.

| | Rewound by a rollback? |
|---|---|
| `/etc/config` | Yes, snapshotted and restored whole |
| Managed files that existed / this run created | Restored / deleted |
| Packages installed / removed by this run | Removed / reinstalled offline from staged files (a removal that cannot be staged is refused) |
| Services enabled at boot, running or not | Yes, `/etc/rc.d` and the running set restored |
| A restart inside the window | Yes, a boot-time copy and `onc-rollback` (START=11) |
| Root's password | No: it is the password the app logs back in with |

- **Host keys.** Trust on first use, a changed key refused; Node and OpenSSH
  share `~/.config/openwrt-configurator/known_hosts` (`src/knownHosts.ts`),
  `dbclient` is held to a pin through a throwaway `$HOME`.
- **Quoting.** Every config value reaching a shell or `uci batch` goes
  through `shellQuote` (`src/shell.ts`); names cannot be quoted, so they are
  validated.
- **Router UI behind uhttpd.** Only fixed headers reach a CGI, so CSRF comes
  from Origin vs Host and the version from `?version=` (`cgi.ts`); unknown
  Hosts are refused (`hosts.ts`); a status needs its reason phrase; logins go
  through rpcd (`auth.ts`) and are refused while root has no password.

## Where to change things

- **A setting:** its feature's `schema.ts`, then `fields.ts` (label), any
  `rules.ts` entry, `compile.ts`, and the page in `ui/src/pages/`;
  `ui/src/settingPages.ts` maps a path to its page.
- **A feature:** a folder under `src/intent/` with an `index.ts`
  `FeatureModule`, added to `modules.ts`.
- **A fix over stock OpenWrt:** a file in `src/intent/patches/`, listed in
  its `index.ts`; the type is `Patch` in `patch.ts`. Declarative and pure in
  the intent:
  - **Provenance:** `title` (one line), `why`, `kind` (`fix`: waits on
    upstream; `tuning`: ours), `required` (its absence silently breaks
    something: it cannot be turned off), `references` (issue, PR, commit,
    forum, docs, or the user's `report`, each with a URL and what it shows),
    `added`, `verified` (where and how it was checked), `dropWhen` in words a
    user reads ("until …" in a chip's tooltip).
  - **Target:** `models`, `targets` (OpenWrt target/subtarget,
    `device.target`, e.g. `mediatek/filogic`), `roles`, `releases`
    (`from`/`before`: give `before` the fixed release once known). `applies`
    when only some intents need it.
  - **Effects:** files, config sections, packages, keeps and services as a
    feature emits; `amend` (options over sections other features made, as
    target-conditioned overrides after the merge: nothing duplicated), scoped
    to the items it concerns with `amendOf(path, { where: ({ item }) => … })`
    (the intent item the section came from, typed: `ft-key-race` amends only
    SSIDs with fast roaming *and* WPA3), so a patch applies only where both
    the device and the config need it; `restarts` (after a firewall reload,
    via an fw4 script include; after a package swap, via the engine's
    `restartOnPackages` records); `note` (one line on the setting's ⓘ);
    `affects` (settings an effect with no option to trace touches: files,
    restarts; for listing only). `effectsOf` says what it does, in words,
    from those, so it cannot drift.
  - **Where it shows** is derived, never written: features record each
    section's `origin` (the item it was made for and the setting behind each
    option; metadata the engine never reads, `withoutOrigins` drops), and a
    patch marks a setting only where its amend gives an option from that
    setting a value other than the setting compiled to
    (`patches/marks.ts`). That setting's row gets a "Fix" chip (what, why,
    until when, a link, and "Turn this fix off" for optional ones); its
    control is greyed out only when the override holds on every device the
    setting reaches, per facts (`overridesAt`). The stored value is never
    touched, so it applies again once the patch drops.
  - **Turned off** by the user in System › Patches (`system.patches.off`;
    unknown and required ids refused): compile skips them. System › Patches
    lists only a patch that overrides a setting (one turned off stays, so it
    can be turned back on); the others apply with no row. It shows each one's
    state per device from stored facts
    (`patchStatus`, `GET /api/patches`: active, off, not needed, not for this
    device and why, fixed in its release, not read); Hardware lists a
    device's fixes; Overview says when one can be dropped (fixed on every
    device it targets, active on none). The apply diff labels the lines a
    patch produces, found by compiling with it off (`fixSources`).
  - **Checked** by `patches.test.ts` (provenance, a known model or a
    reference, `releases.before` after `oldestSupportedRelease` or "drop
    me", every amend matching compiled sections in generated intents, every
    amended option traced or `affects` declared, the derived marks, the
    greying and the drop), `patchReleases.test.ts` (present exactly in its
    range) and `fixes.test.ts` (states, droppable, diff attribution, the
    API). The generative check turns random optional patches off. `compile`
    lists each device's patches, their references and when they go.
- **A device question:** a `Probe<T>` in `src/deviceProbes.ts` (or a status
  probe group in `src/status/device/`), its parser tested on recorded output.
- **An API route:** the area's module in `src/server/api/`, as data for the
  router; failures as `Problem`s.
- **An agent verb:** `src/agent/script.ts` (plain POSIX sh, busybox-safe),
  its call in `src/agent/index.ts`, a test in `agent.test.ts`, the fake device
  in `src/tests/helpers/fakeDevice.ts`.
- **A placeholder:** `plan/types.ts`, `plan/positions.ts`, the engine's
  fitting, and `lowLevel/placeholders.ts`.

## Testing

`ava` over `src/tests/main/*.test.ts`; shared code in `src/tests/helpers/`
(ava ignores it). All offline. Invariants live in tests; read the test, not
prose:

| Guarded invariant | Test |
|---|---|
| Plan round trip, every generated intent compiles, verifies, no duplicate names | `generative.test.ts` (`ONC_GEN_CASES` for more) |
| Rules have no dead ends; every rule path is a labelled setting | `choices.test.ts`, `uiHistory.test.ts` |
| Explainers match what is compiled | `explain.test.ts` |
| Hardware fitting, DSA and swconfig | `hardware.test.ts`, `hardwareSnapshots.test.ts` |
| Option order on devices | `uciOrder.test.ts` |
| Every apply failure path, one change across devices | `provisionNetwork.test.ts` on `fakeDevice.ts`, virtual clock |
| The agent's verbs under plain `sh` | `agent.test.ts`, `rollback.test.ts` |
| Node and QuickJS agree byte for byte | `qjsParity.test.ts` (fails in CI without `qjs`) |
| No Node outside platforms | `platformBoundary.test.ts` |
| Secrets never printed | `redaction.test.ts`, `resolveSecrets.test.ts` |
| Hostile strings through a real `sh` | `shell.test.ts` |
| Login, CSRF, Host, throttle | `auth.test.ts`, `cgi.test.ts`, `hosts.test.ts`, `server.test.ts`, `api.test.ts` |
| The apply job's life (kill, pid reuse, reboot) | `provisionJob.test.ts` |

- **Refactors:** `npm run equivalence -- [<ref>]` compares every device's
  output for a seeded corpus against a git ref; deliberate changes go in
  `scripts/equivalence.expected.json` (`--expect`).
- **The rig:** `scripts/rig-test.sh` provisions OpenWrt in Docker over every
  SSH client path (`dbclient`, OpenSSH, Node, two devices).
  `ONC_RIG_VERSION` picks the release (25.12.5 by default; CI runs 25.12.0,
  25.12.5 and SNAPSHOT, the snapshot allowed to fail), `ONC_RIG_KEEP=1` keeps
  the containers for a look; the image choice is `scripts/openwrt-image.sh`
  (the arm64 rootfs is labelled `linux/aarch64_generic`: pulled by that
  label, run with no `--platform`).
- **mwan3:** `scripts/mwan3-test.sh` (CI too) runs a router with two lines as
  the app compiles them and drops the main line's pings: mwan3track's real
  log lines (recorded with `RECORD=1` into
  `src/tests/helpers/status/mwan3-failover.txt`, read by `mwan3Log.test.ts`)
  and the IPv6-follows-the-line hook taking `wan6` down and back.
- **Releases and boards:** `patchReleases.test.ts` applies every patch
  through the engine on each side of its release range;
  `swconfigLayout.test.ts` checks a swconfig router's layout against
  OpenWrt's own `config_generate` for the same board.
- **The router UI end to end:** boot `openwrt/rootfs:armsr-armv8-v25.12.5`
  with `docker run -d --privileged … /sbin/init`. Once booted it has no route
  out (netifd moves eth0 into `br-lan`), so fetch `quickjs` and its
  dependencies from an un-booted container (`apk fetch -R quickjs`), copy them
  to `/root` (its `/tmp` is a tmpfs `docker cp` cannot reach) and install with
  `apk add --allow-untrusted --repositories-file /dev/null`; then install the
  bundle, `dist/ui` and `packaging/openwrt/…/onc.cgi` and talk to uhttpd.

## Verified on OpenWrt 25.12.5

Each is the reason for code that looks odd; the detail is in the comment
named.

- mwan3track logs "Interface wan (eth1) is offline"/"online" and sends
  `disconnected`/`connected` to the iface hotplug scripts
  (`scripts/mwan3-test.sh`, `internet/compile.ts`'s hook).
- `reload_config` skips configs new since boot unless the baseline is
  refreshed first (`agent/script.ts`, prepare).
- `uci batch` exits 0 on failure; only stderr tells (agent, stage).
- `uci commit`/`revert` exit 1 on a missing config (agent, finalise).
- uci refuses a hyphen in a section name (`plan/rules.ts`).
- dropbear never signals a command on disconnect; refuses exec requests
  over ~9 KB (`agent/script.ts` header, `agent/records.ts`).
- busybox has no sub-second `sleep`; `setsid` run by QuickJS keeps the pid
  (agent `settle`, `platforms/qjs/process.ts`).
- A stock root has no password: SSH and rpcd accept any
  (`intent/system/compile.ts`, `server/auth.ts`).
- uhttpd passes a CGI only fixed headers and needs a reason phrase
  (`server/cgi.ts`).
- fw4 skips a rule whose ports are comma-separated (`intent/firewall/schema.ts`).
- miniupnpd 2.3.9 refuses to forward with a private WAN address; `use_stun`
  finds the outer one (`intent/internet/compile.ts`). A `fw4 reload` empties
  its chains and it never re-adds them; a restart restores them from its
  lease file.
- 25.12's random `dhcp_default_duid` is wiped and not replaced: DHCP
  identifies by MAC, and DHCPv4 sends no RFC 4361 client-id
  (`intent/networks/compile.ts`).
- 25.12's mwan3 status can hold bare `nan` (`status/device/internet.ts`).
- An AP's carried VLAN gets an IPv6 link-local address unless `ipv6 0`
  (`intent/networks/compile.ts`).
- https-dns-proxy, usteer and mwan3 still act when "disabled"; they are
  stopped (`intent/fragment.ts` `serviceWhen`, each feature's compile).
- netifd learns protocol handlers only at start (agent, finalise).
- dnsmasq's `strictorder` asks two local upstreams in their order and fails
  over to the second while the first is down: the DoH fallback
  (`intent/dns/compile.ts`).
- fw4 makes a redirect IPv4-only unless `family any`; without `dest_ip` it
  DNATs to the router: a client asking 8.8.8.8 got the router's answer
  (`intent/dns/compile.ts`, keeping devices on the router's DNS).
- netifd resolves a WireGuard endpoint name once, at ifup; wireguard-tools'
  `wireguard_watchdog`, run from cron, re-resolves silent peers (`intent/vpn/compile.ts`).
- `apk add --repositories-file /dev/null` installs staged files offline
  (agent, watchdog restore).
- LuCI's unsaved changes are per rpcd session, untouched by `uci revert`
  (agent, `revert_pending`).

## Gotchas

- **Node's stdout into a pipe is asynchronous, and `process.exit` drops what the pipe has not taken**, which cut `compile | jq` off at 64 KiB. The entry point (`bin/index.ts`) makes stdout and stderr blocking first (`blockingStdio`), so `platform.exit` stays synchronous (`never`: callers rely on it); QuickJS flushes in its own `exit`. `cliOutput.test.ts` pipes 200 KB+ through.
- **The CLI version is duplicated.** `package.json` `version` and the `version` in the spec in `src/cli/index.ts` must be bumped together.
- **Releases are tag-driven.** `.github/workflows/release.yml` fires on a pushed `X.Y.Z` or `vX.Y.Z` tag, runs `test.yml` (tests, typecheck, rig) as a gate, checks the tag against the version, then publishes the binaries, the bundle, the OpenWrt feed and the Homebrew formula (see "Packaging").
- **`print-uci-commands` builds against the live SSH session**, the same as `provision`. It used to call `getDeviceScript({ state })` with no session, so package diffing never ran: every package the config named was printed as an install and every removal as a removal, regardless of what was on the device. That reported a 21-package `apk del` cascade for packages that were not installed at all. Keep the session open until the script is built, or the dry run stops matching what a provision would do. Resolved `$secret` values are redacted in the printed script; `--show-secrets` turns that off — don't pass it unless the user asks.
- **`$secret` refs are resolved once at load** (`loadConfig`), before schema parse, and only in low-level files. The rest of the pipeline still sees plaintext strings. `secrets set` prompts for a value and stores it; there is no `get`.
- **`images/` is gitignored** — built sysupgrade images bake hostnames and LAN IPs into the artifact.
- **`uci batch` exits 0 even when an operation fails**, reporting the error only on stderr. The agent's stage therefore captures its stderr and fails the step if it is non-empty. Don't switch that back to checking the exit code. The wipe's deletes go through the same batch: each names a section read from the device after the prepare step, so a failed one is a real error.
- **The `installedPackages` probe uses `apk info`**, which prints bare names. It previously parsed `apk list --installed` by splitting on the last `-`, which mangled 86% of names (`curl-8.19.0-r2` → `curl-8.19.0`) so nothing ever matched: removals were silently dropped and installs re-ran every provision.
- **Code style:** heavy functional composition — `reduce`/spread over mutation, arrow-function exports, object-destructured named parameters (`({ plan, deviceConfig })`). Match it. Comments are sparse and explain *why*, usually a device-level quirk worth preserving.
