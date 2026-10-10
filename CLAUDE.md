# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Never read secrets from config files

**This is the highest-priority rule in this file. It overrides convenience, debugging, and "I just need to see the shape of it."**

Real network config files in this repo may still contain live credentials: SSH root passwords (`provisioning_config.ssh_auth.password`), Wi-Fi PSKs (`key` on `wifi-iface` sections), PPPoE credentials (`username`/`password` on `interface` sections), and DDNS/VPN tokens. Prefer `{ "$secret": "wifi/home" }` refs (resolved from the macOS keychain at load) so a grep of the file is not a leak.

Do **not** open, `cat`, `grep`, print, or otherwise pull the contents of:

- `*.config.json` at the repo root (e.g. `stellenberg.config.json`) — gitignored, mode `0600`, real.
- Anything under `configs/` — gitignored, and a separate nested git repo of the user's live network configs.
- Any file the user points at as "my config" / "my network config", wherever it lives.

If you need to understand config *structure*, use the committed fixtures instead — they contain only placeholder secrets:

- `sampleConfigs/basic.json`
- `src/tests/main/config.json`, `src/tests/main/config2.json`
- `README.md` (documents every top-level key with examples)

If a task genuinely cannot proceed without something in a real config file, stop and ask the user to paste the specific non-secret value. Never dump the file to find it.

Corollaries: don't echo a secret you happened to encounter, don't write one into a test fixture, commit message, log line, or scratch file, and don't add code that logs `ssh_auth` or wireless `key` values. Do not resolve `$secret` refs or pass `--show-secrets` just to inspect values. Do not dump UCI `wireless`/`network` password fields off a live device either — after provision those values live in UCI because OpenWrt needs them.

## Never provision without being asked

`provision` connects over SSH to real routers and access points and rewrites their UCI config. A bad config can drop the network or lock the user out of a device mid-run.

- Never run `npm run provision`, `build-images` (non-dry-run), or the built binary against real devices unless the user explicitly asks in that message.
- `print-uci-commands` is read-only *on the device*, but it still opens an SSH connection to introspect it (see "Device schemas are introspected live"). Treat it as a network action, not a local one.
- The only fully offline commands are `npm test`, `npm run build`, and `build-images --dry-run` (which only reaches out to the OpenWrt ASU API for profile resolution, and tolerates that failing).

## What this project is

A CLI that takes one UCI-like JSON file describing an entire network — every device, its packages, firmware version, UCI config and arbitrary files — and provisions it to OpenWrt devices over SSH. The JSON is conditionally composed with `.if` / `.overrides` keys so a single file drives routers, switches and dumb APs of different models.

Published to GitHub Releases as standalone binaries (macOS/Linux/Windows) via `@yao-pkg/pkg`.

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
npm run package          # pkg -> ./artifacts (needs npm run build first)
npm run ui -- <intent>   # build the web UI and serve it on http://127.0.0.1:8080

# Against real devices — only on explicit request:
npm run provision          <config-file>
npm run print-uci-commands <config-file>
npm run build-images       <config-file> [--dry-run] [--out ./images] [--concurrency 3]
```

Node 24 (`.node-version`), TypeScript 6, CommonJS. `ts-node --transpile-only` for the dev scripts, so type errors do **not** surface there — run `npm run build` to typecheck.

## Architecture

The pipeline, in dependency order:

1. **`bin/index.ts`** → **`src/cli.ts`** — `bin/index.ts` (Node) and `bin/qjs.ts` (QuickJS) are only entry points: each builds its platform (see "The platform boundary") and calls `run({ argv, platform })`. The CLI lives in `src/cli.ts`, as command specs parsed by the small `src/args.ts` (no commander). It reads the config file via `loadOncConfig`: `parseConfigJson` (`src/parseJson.ts`: JSONC — comments and trailing commas allowed — via `jsonc-parser`, with `file:line:col` errors that read the same on every engine; device output goes through the strict `parseJson`), resolve `{ "$secret": "name" }` from the macOS keychain (`src/resolveSecrets.ts`), then `parseSchema(oncConfigSchema, ...)`. `print-uci-commands` and `build-images --dry-run` redact resolved values unless `--show-secrets`.
2. **`src/oncConfigSchema.ts`** — zod schema for the *input* JSON ("ONC config"): `version`, `devices`, `package_profiles`, `files`, `configs_to_not_reset`, `config`. `.strict()` throughout, so unknown keys are hard errors by design.
3. **`src/getDeviceSchema.ts`** — builds a `DeviceSchema` (ports, radios, CPU port, firmware version) for each device.
4. **`src/resolveOncConfig.ts`** — collapses `.if` / `.overrides` for one device. `conditionMatches` evaluates conditions against `device.tag.*`, `device.hostname`, `device.ipaddr`, `device.model_id`, `device.version`, `device.sw_config`, parsed by `src/condition.ts` (a small recursive-descent parser: `==`, `!=`, `in [...]`, `AND`/`OR`/`NOT` and their `&&`/`||`/`!` spellings, parentheses, quoted strings with escapes). A tag the device does not set is absent (`==` false, `!=` true) rather than an error, since every device shares the conditions; an unknown built-in name still throws, to catch typos.
5. **`src/getOpenWrtConfig.ts`** — the interesting one. Turns abstractions into concrete UCI: expands `@cpu_port`, resolves `"*"` / `"*t"` port wildcards to actual unused physical ports (at most one device section per device may use `"*"`: only explicit lists count as uses, so two would each claim every free port), maps `bridge-vlan` (DSA) vs `switch_vlan` (legacy swconfig) depending on `deviceSchema.sw_config`, assigns `.name`s, injects the hostname, and expands `wifi-iface` across radios by band.
6. **`src/getOpenWrtState.ts`** — adds packages to install/uninstall, which config sections to reset, and resolved `files`.
7. **`src/getUciCommands.ts`** + **`src/getDeviceScript.ts`** + **`src/uci.ts`** — emit the scripts, in three parts that `provision` runs separately. **Prepare** (`getPrepareCommands`): discard every pending UCI change (clean start, see below) → package install/removal → `reload_config` (baseline refresh, see below). **Stage** (`getStageCommands`, built from the device's config as read *after* prepare): one `uci batch` that deletes every section `configs_to_not_reset` does not keep, by exact name, then sets every declared section → file writes (each with its optional `run_after`). **Finalise** (`getFinaliseCommands`): `uci commit` per changed config → `reload_config`. Then each `run_after_reload`, over the *reconnected* session: `reload_config` is what can sever the link, and once dropbear exits the next marker `printf` in `execScript` takes SIGPIPE and kills the script, so a hook after the reload in that same script would be silently dropped on exactly the runs that reshape networking. `getDeviceScript` concatenates all of it for the dry run (see "The wipe").
8. **`src/execScript.ts`** — runs the whole command list as one script: it is written to a `0600` file in `/tmp` over stdin (`cat >`), then run as `sh <file> < /dev/null`. Do not "simplify" this into a single joined exec string: dropbear rejects exec requests over ~9 KB and drops the connection on larger ones, while a real provision script is comfortably past that. Nor pipe it straight into `sh`: commands that read stdin then swallow the rest of the script. `set -e` plus a marker echoed after each command preserves per-command failure granularity.
9. **`src/devicePhases.ts`** + **`src/provisionNetwork.ts`** — provisioning as explicit phases over a `DeviceRun` record: `planDevice` (verify the board id, read state, warn about removals and discarded changes) → `armRollback` → `configureDevice` (prepare, read the config, stage, read back and verify) → `ensureTimeToConfirm` → `commitDevice` → `confirmDevice` → `disarmDevice` → `runPostReloadHooks`, plus the ways out: `revertStaged` (nothing committed), `rollBackNow` and `waitForRecovery`. Each phase returns an updated record or throws a `ProvisionFailure` saying whether the device's change was committed. `provisionNetwork` runs them across every device as **one change** (see "Several devices, one change"); a single device is N = 1. Files are written *before* `uci commit` so a write failure leaves the revert effective. Every question asked of a device is a typed probe in **`src/deviceProbes.ts`** (see "Device probes").

### The intent layer and the web UI

An *intent file* (`{"schema": 1, ...}`, `src/intent/schema.ts`) describes the network in the user's terms: site, devices (name + role), internet, the home network, Wi-Fi, DNS. It holds decisions only, **never device facts** (model, ports, radios, version): those are read from the devices at provision time. `compileIntent` (`src/intent/compile.ts`) is pure: each module in `src/intent/features/` returns a fragment of low-level config and they are merged in order. Anything device-specific is left to the engine as a condition (`.if device.model_id == ...`) or a placeholder (`"*"` ports, `@wan_port`, `@cpu_port`). `loadOncConfig` compiles an intent file transparently, so every command takes one; `compile` prints the result. There is no escape hatch: a setting the intent cannot express does not exist, and because of the wipe, the features plus their defaults must produce a complete working device.

The web UI edits the intent file and nothing else. `src/server/handlers.ts` is the whole backend (GET/PUT `/api/intent` plus the built UI's static files), transport-free: `onc ui` serves it with Node on a Mac (loopback, Host/Origin-checked against DNS rebinding), `onc cgi` answers one request under uhttpd on a router (QuickJS cannot listen on a socket). A save is validated by the intent schema and by compiling, then written atomically with mode `0600` (it holds the Wi-Fi passwords). **The API has no authentication yet: do not expose `cgi` on a router** (see `TODO.md`).

`ui/` is React + Mantine + React Query + React Hook Form + React Router, built by `scripts/build-ui.js` (esbuild) into `dist/ui`. Layers: `data/` (the only HTTP code, as React Query hooks), `kit/` (presentation: `SettingsPage`, `Section`, `SettingRow`, `DataTable`, `ConfirmButton`, `LogView`), `form/` (fields bound to the intent by name, e.g. `<TextField name="site.name" />`, validated with the same zod schema as the server; `ListPage` turns a `defineList` spec into a table page and per-item pages), `provision/` (the header button and its panel), and `pages/`, which stay declarative: which settings, in what order, labelled how. Inputs should make invalid values impossible, not just rejected: dropdowns and structured fields (`SubnetField`, `DurationField`) over free text, with every rule in the shared schema so the server enforces it too; the draft is validated on load, so problems already in a file show at once. URLs are relative and routing is a hash router, so the same build works at `/` and under `/cgi-bin/onc/`. Every API write must carry `X-ONC: 1` (CSRF). `src/intent/timezones.ts` and `countries.ts` are generated by `scripts/gen-timezones.js`.

The provision panel diffs the draft against the last provisioned intent with `src/intent/diff.ts`, labelled by `src/intent/fields.ts` (secrets only ever read "Changed"). A provision runs as `selfCommand() provision <snapshot>` in the background, its state in `<intent>.state/` (`src/server/provisionJob.ts`); a successful run makes the snapshot `live.json`. The API refuses to provision a draft that does not validate and compile.

### The platform boundary

Nothing in `src/` outside `src/platforms/` may import a Node built-in or a Node-only package (`node-ssh`), or touch `process` — a test enforces it (`platformBoundary.test.ts`). The goal is one bundle that runs under Node on a workstation and under QuickJS on an OpenWrt device. All runtime access goes through a `Platform` (`src/platform.ts`): files, `sha256`, HTTP, local processes, `connect` (returns a `Session`, shaped like node-ssh's `execCommand`/`dispose`), env, sleep and exit. There is no global: the entry point builds one (`nodePlatform` or `qjsPlatform`) and passes it down, and each function takes only what it uses, typed `Pick<Platform, ...>` (or just a `sleep`), so a test can hand in a fake. Tests pass `nodePlatform` explicitly.

### Running under QuickJS

`npm run bundle` builds `dist/qjs/openwrt-configurator.mjs` from `bin/qjs.ts` with the options in `scripts/bundle.js`, which the parity test reuses; run it with `qjs --module`. Bundles prefer packages' ESM builds (`mainFields: module, main`): jsonc-parser's UMD `main` does a dynamic `require` QuickJS cannot satisfy. The QuickJS platform is `src/platforms/qjs/`: `process.ts` (temp-file stdio, spawn), `files.ts` (files and hashing), `http.ts` (curl), `ssh.ts` (transports), `runtime.ts` (typed `os`), assembled in `index.ts`. Things that differ from Node and are easy to trip over:

- **QuickJS has only `console.log`**, no `setTimeout`, `Buffer` or `TextEncoder`/`TextDecoder`. `qjsGlobals.ts` (imported first by every QuickJS entry) polyfills `console.warn`/`error` to stderr; the boundary test bans the rest outside `platforms/` (`src/utf8.ts` covers the UTF-8 needs).
- **`@types/node` owns the module name `"os"`**, so QuickJS's `os` is typed as the global `QuickJsOs` interface in `quickjs.d.ts` and cast on import.
- **SSH is a spawned client per command**: `dbclient` when present (OpenWrt), else OpenSSH. A password reaches OpenSSH through a generated `SSH_ASKPASS` helper and dbclient through `DROPBEAR_PASSWORD`, never argv. Host keys are checked; see "Host keys".
- **Exit status comes from a marker, not the client.** Each remote command is wrapped as `( cmd ) ; printf '__ONC_EXIT__%s' $? >&2`, because both clients reuse the remote exit codes for their own failures (OpenSSH 255, dbclient 1). No marker means the command never finished, reported as `code: null` just like node-ssh's dropped channel.
- **Local mode**: when the target host is one of this machine's addresses, commands run through `sh -c` with the same wrapping, so a device can provision itself. Its session is marked `local`, and commit-confirm then needs more than a reconnect, since a local session never drops: `reachableSession` also requires the device's own address to answer SSH (`sshAnswersCommand`, busybox `nc` killed after 2 s, looking for dropbear's `SSH-` banner). That catches a lost address or dropbear no longer listening; it cannot catch a firewall or cabling change that only affects other hosts. Run a local provision under `setsid`: if it is started from an SSH session that the reload drops, it dies and the watchdog rolls back.
- **Secrets** come from the macOS keychain on macOS and from `/etc/onc/secrets.json` (`{ "name": "value" }`, must be `0600`; `ONC_SECRETS_FILE` overrides) elsewhere. Its parse errors deliberately carry no excerpt.
- HTTP uses `curl`; sha256 uses `sha256sum` or `shasum`.

### Packaging

A pushed tag runs `.github/workflows/release.yml`. Besides the `pkg` binaries it attaches the QuickJS bundle, then:

- **OpenWrt feed** — `packaging/openwrt/build.sh` builds `packaging/openwrt/openwrt-configurator/` (`PKGARCH:=all`, `DEPENDS:=+quickjs`) in the `openwrt/sdk:x86-64-v25.12.5` image and signs the index with the `OPENWRT_FEED_KEY` secret (an EC P-256 PEM). The feed and its public key are published to GitHub Pages under `/openwrt/`. The key must never change: devices trust the feed by it. The SDK does not sign the `.apk` itself; apk verifies it through the signed index's hash, like OpenWrt's own feeds. Without a key the script generates a throwaway one, fine for local testing only. The SDK warns that `quickjs` "does not exist" (it lacks the packages feed); the dependency is still recorded.
- **Homebrew** — `packaging/homebrew/render.sh` fills `openwrt-configurator.rb.in` with the release URL and sha256, and the workflow pushes it to `jasrusable/homebrew-tap` over SSH with a write deploy key on that repo (the `HOMEBREW_TAP_DEPLOY_KEY` secret). The formula's test checks `--version` against the tag, which is why the workflow also refuses a tag that disagrees with `package.json` and `src/cli.ts`.

To test the package without a device, install it into `openwrt/rootfs:x86-64-v25.12.5` from a `file://` feed.

### Host keys

Trust on first use, everywhere. A device's key is recorded the first time and a different key is refused (`hostKeyChangedMessage` says which line to delete after a reflash). Node (ssh2's `hostVerifier`) and OpenSSH (`StrictHostKeyChecking=accept-new`, `HashKnownHosts=no`) share `~/.config/openwrt-configurator/known_hosts` (`ONC_KNOWN_HOSTS` overrides) in plain OpenSSH format; `src/knownHosts.ts` holds the pure logic. Once a host's key type is known, Node negotiates only that type, so a server cannot sidestep the check by offering another — `checkHostKey` treats an unseen type for a known host as changed. On a device, `dbclient` keeps its own `~/.ssh/known_hosts` (single `-y`: accepts new, refuses changed).

### Several devices, one change

`provisionNetwork` makes a run all-or-nothing: plan every device (nothing changes), arm every device's watchdog (snapshots only), configure and commit each, then confirm **all** of them before disarming any. The window is `--confirm-timeout` × number of devices, and the commit of any device is refused if the earliest deadline leaves too little time to confirm. On a failure in configure or commit, devices already committed are rolled back immediately (`rollBackNow`: the watchdog sleeps in the background with its pid in `sleepPidFile`, so killing that sleep makes it run its restore now) and untouched ones are disarmed. If a device cannot be reached to confirm, the others are rolled back now and it rolls itself back at its deadline. Order matters, since changing a device can cut the path to others: devices are provisioned in config order except that the workstation's default gateway (`src/gateway.ts`) and the device running the tool (a `local` session) go last (`provisioningOrder`). The rig's `network` job checks a lockout on one device rolls back both.

### Commit-confirm

Because committing `network`/`firewall` can sever the connection doing the provisioning, `provision` snapshots state, starts a detached `setsid` watchdog, commits, then reconnects (retrying, since `reload_config` briefly drops the network) and touches its confirm flag to disarm it. If the tool cannot get back in, the device rolls back and reboots itself. `--no-confirm` disables it; `--confirm-timeout` changes the 90 s window (minimum 60: the window is timed from arming, so it must cover configuring *and* leave 30 s to confirm). `ONC_TEST_MIN_CONFIRM_WINDOW` (seconds, at least 10) lowers that 30 s for tests and prints a warning; never use it against real devices.

**Confirming waits for services to settle.** `reload_config` only signals services; procd restarts them afterwards. Reconnecting straight after the commit raced that: on the test rig, a config that dropped dropbear's section was confirmed while the old dropbear was still listening, then locked the device out a second later. So `reconnectSettled` reconnects, waits on the device until procd's service table (`ubus call service list`, which carries every instance's pid and parameters) has been unchanged for three seconds — procd runs reload triggers after `PROCD_RELOAD_DELAY`, 1 s — then reconnects *again* and confirms over that fresh session. The wait is capped at 20 s and by the window.

What the rollback covers, best to worst:

| | Rewound? |
|---|---|
| `/etc/config` | Yes — snapshotted and restored wholesale |
| Managed files that existed before | Yes — archived with `tar`, restored |
| Managed files this run creates | Yes — deleted |
| Packages this run installs | Yes — `apk del` needs no network |
| Packages this run removes | Usually — staged beforehand, see below |

**Package staging.** Before removing anything — while the link is still up — `provision` runs `apk fetch` over the whole `apk del --simulate --rdepends` cascade into the rollback directory. A rollback then reinstalls with `apk add --allow-untrusted --repositories-file /dev/null`, which resolves with **no repositories configured at all** (verified on-device), so it works with the network down.

Package changes are undone in reverse: newly installed packages are removed *first*, then removed ones reinstalled, because the two can conflict (`wpad-mbedtls` and `wpad-basic-mbedtls` do).

Fast-moving feeds drop old builds, so where the exact installed version is no longer published `apk fetch` takes the newest available — LuCI especially. A rollback therefore restores a working package set, not necessarily byte-identical versions. The `firewall4` cascade is 21 packages / 380 KB / ~3s on the test device.

`provision` prints the full removal cascade before acting: on a stock image, removing `firewall4` takes 21 packages with it, `uhttpd` and all of LuCI included, because `luci-light` depends on `luci-app-firewall`.

Rollback paths are per-run (`/tmp/onc-*-<runId>`). With fixed paths, a second provision inside the confirm window would clear the flag that had already disarmed an earlier watchdog, which would then wake and restore a stale snapshot over a healthy device.

`at` and `nohup` are **not** present on a stock OpenWrt image — `setsid` is, and a process started that way outlives the SSH session. Note that killing the CLI between arming and confirming will let the watchdog fire.

`src/getBuildPlan.ts` + `src/buildImage.ts` are a separate branch off step 2: they resolve version/packages/LAN/timezone into an ASU (firmware-selector) build request with a generated UCI-defaults bootstrap script, poll the build, and download + sha256-verify the sysupgrade image.

### How changes actually get applied

`uci commit` writes `/etc/config`; `reload_config` is what makes services re-read it. It diffs `uci show <pkg>` against `/var/run/config.md5` using `md5sum -c`, and fires a `config.change` ubus event per changed package. Services pick that up via `procd_add_reload_trigger`. All five first-class packages are covered: netifd registers `network` **and** `wireless` (and `wifi reload` is literally `ubus call network reload`, so wireless needs no special handling), dnsmasq registers `dhcp`/`system`, firewall4 registers `firewall`, and `/etc/init.d/system` registers `system`.

**`md5sum -c` never checks a file missing from the baseline.** The baseline is written only by `/etc/init.d/boot` and by `reload_config` itself — installing a package does not refresh it, since `default_postinst` runs `<init> enable/start` but never `reload_config`. So a config file that first appears during a provision would get no reload event at all on that run: the service would start on its shipped defaults and keep them until a reboot, while `uci show` reported the intended config. That is why the script runs `reload_config` once after the package step and **before** any staging (`baselineRefreshCommands`). It must stay before staging — `reload_config` compares `uci show`, which includes uncommitted deltas, so refreshing it later would record this run's own changes as the baseline and the closing reload would fire nothing.

Corollary: don't use a `files` entry to create something under `/etc/config`. Files are written after staging, so a config created that way misses the baseline refresh. Drive UCI through `config` instead.

### Each run starts from committed state, and commits by name

The tool owns the device's config, so before staging anything the script discards **every** pending UCI change on the device, whoever made it (`revertPendingCommands`; the package list comes from `uci changes` on the device). The same command is the abort path and the watchdog's revert. It has to be everything: a run that dies before it can revert leaves deltas in `/tmp/.uci` that the watchdog's `/etc/config` restore does not touch; `default_postinst` ends with a bare `uci commit` for any package shipping `/etc/uci-defaults`, so a package install mid-run would commit whatever was staged anywhere; and a rollback's own `reload_config` reads deltas on top of the restored files. It must run before the packages step. `provision` first prints what it is discarding, as per-package counts only (`summarisePendingChanges`) — staged values can be secrets.

LuCI's unsaved changes are **not** affected: rpcd stages them per session under `/var/run/rpcd/uci-<session>`, which plain `uci changes`/`uci revert` never see (verified on 25.12.5; the rig checks it).

The commit stays `uci commit <pkg>` per changed config (`changedConfigs`: configs with a section to wipe, plus configs the run declares sections in) rather than a bare `uci commit`, so it never commits anything it did not stage.

### The wipe

The config file is the whole truth: every run leaves each device's UCI config exactly as declared, whatever it held before, except what `configs_to_not_reset` keeps (`<config>.*`, or `<config>.<section type>` — types, not section names). So `configureDevice`:

1. runs the prepare step — packages are what change config behind our back (postinst, uci-defaults), and they can bring whole new configs and section types;
2. reads every config with the `uciConfigs` probe (one `uci export` per `/etc/config` file, staged changes included; a full `uci export` silently skips a config it cannot parse, so per-file it can name it) and parses it in `src/uci.ts`, quote-aware — a multi-line value can contain a line reading `config x`;
3. stages the wipe and the declared config in one batch (anonymous sections are deleted as `@type[0]`, once each, after the named ones);
4. reads it back and **verifies** (`verifyConfigs`): every config not kept must hold exactly the declared sections, in order, with exactly the declared options, lists as lists. A declared section of a kept type is merged, so only its options are checked. Any difference reverts with nothing committed; messages name sections and options, never values.

The wipe used to be computed at plan time from section *types* and deleted with shell loops: sections a package added mid-run survived it, a staged deletion hid a type from it, and a device value could inject into the script. Verification is what makes the guarantee checked rather than reasoned. An unreadable config that is not kept stops the run. A keep entry naming a config the device lacks is warned about (typos there lock you out). `uci set` of an empty value deletes the option, so `declaredConfigs` leaves empty values and empty lists out. The dry run reads the config before packages are installed, so it does not show their sections being wiped.

Both are guarded with `if [ -f /etc/config/<pkg> ]`: `uci commit` and `uci revert` both exit 1 on a config that is not present (verified on 25.12.5) and the script runs under `set -e`, so one absent config would otherwise abort the provision — or stop a rollback's remaining reverts partway.

`getFinaliseCommands(state)` is derived from state rather than being a constant, so `planDevice` must use it (not a fixed length) to split the configure phase from the finalise phase.

### Dropbear does not kill your command

When the connection drops, dropbear does **not** signal the running command — its only `kill()` is for an explicit client signal request, there is no `setsid`/`setpgid`, and a non-pty exec has no controlling terminal. OpenWrt defaults are `SSHKeepAlive:300`, `IdleTimeout:0`, so it may not even notice a blackholed peer for five minutes. Measured on 25.12.5: a remote loop writing only to a file finished 12/12 iterations after its client was killed; an identical loop writing to stdout died at 3/12.

Two consequences. The commit step is safe — `reload_config` writes nothing to stdout, so it runs to completion even if committing severs the link. But the per-command marker in `execScript` means the configure phase dies by SIGPIPE within about one command of a *clean* disconnect, and on a blackholed network an abandoned script can keep executing for up to `SSHKeepAlive` while the watchdog is already restoring `/etc/config`.

### Two parallel schema hierarchies

Under `src/configSchemas/<package>/`, every UCI section has **two** zod schemas:

- `networkInterfaceSchema` — the strict *output* shape, used by `openWrtConfigSchema` to validate what gets turned into `uci` commands.
- `oncNetworkInterfaceSchema` — the *input* shape: same fields, but `.partial()` and extended with `.if` / `.overrides` / `.name`.

The `index.ts` in each package folder wires them up with helpers from `src/utils.ts` (`sectionSchema`, `oncSectionSchema`, `configSchema`, `makeOncConfigSchema`, `getExtensionObject`).

**Adding support for a new UCI option means editing both schemas.** Adding a whole new section type also means adding it to that package's `index.ts`. What gets wiped does not depend on these schemas: it is read from the device (see "The wipe").

### Device probes

Everything the tool asks a device is a `Probe<T>` in `src/deviceProbes.ts`: a command plus the parse of its result — board.json, radios, every config (`uciConfigs`), the release, installed packages, the managed-files manifest, the removal cascade, pending changes, the staged-package count, whether an address answers SSH, the services settling, and disarming the watchdog. `runProbes(session, {...})` sends several in one round trip (each in a subshell, outputs split on a `__ONC_PROBE__<status>` marker line), which matters under QuickJS where every round trip is a new SSH process. **node-ssh trims command output and the QuickJS transports do not**, so the marker split must not depend on leading or trailing newlines (a test covers it). Parsers are tested against recorded output, without SSH. The script protocol (`execScript`'s markers) and the transport's `__ONC_EXIT__` are separate: they wrap commands rather than ask questions.

### Quoting

Every value from the config that reaches a shell or `uci batch` goes through `shellQuote` (`src/shell.ts`): UCI values and list items, file paths, modes, package names. `uci batch` accepts the same `'\''` form as sh (verified on 25.12.5); before this, any value containing `'` aborted the provision. UCI *names* cannot be quoted, so `getUciCommands` rejects a package, section type or option name that is not a plain word; package names, file modes and paths are validated by the schema. `shell.test.ts` runs hostile strings through a real `sh`, and the rig sets a value with quotes and `$(...)` on every client path.

### Device schemas are introspected live

`getDeviceSchema` normally SSHes into the device and derives everything from it:

- `/etc/board.json` → ports, and whether the device is legacy swconfig (`.switch` present) or DSA.
- `ubus call uci get '{"config":"wireless","type":"wifi-device"}'` → radios (band, path, type).
- `/etc/openwrt_release` → `DISTRIB_RELEASE`.

The checked-in `deviceSchemas/*.json` files are only used when `getDeviceSchema` is given `local` (a file reader, e.g. `nodePlatform`) — that path exists for the tests. Two are old (21.02 EdgeRouter X and Archer C50); `friendlyarm,nanopi-r6s` and `zyxel,nwa50ax-pro` were captured from the user's own devices with `capture-device-schema <config>` (read-only, like `print-uci-commands`; a schema holds port names, radio band/type/path and the version — no option values). Don't assume it's the normal path.

### Managed files

`files` entries are written via a quoted heredoc (not `base64` — busybox on small-flash builds often lacks the applet). The set of written paths is recorded in `/etc/onc/managed_files` on the device, so a file removed from the config is `rm -f`'d on the next provision. `run_after` runs immediately after the write.

## Tests

`ava` with `ts-node/register/transpile-only`, in `src/tests/main/`. Note ava's default glob picks up **everything** under a `tests/` directory, so `network2.ts` is a test file despite the missing `.test` suffix.

Most tests are golden-ish: load `config.json` / `config2.json`, build the OpenWrt config against a local device schema, and assert on the resulting structure. `files.test.ts`, `uci.test.ts` and `resolveSecrets.test.ts` are focused unit tests. All are offline — no test touches the network or the keychain (lookups are injected).

`qjsParity.test.ts` runs the same work under Node and QuickJS and requires identical results: 11 CLI invocations (stdout, stderr and exit code), a report of everything the pipeline derives from the fixtures (`src/tests/helpers/parityReport.ts`), and the session layer over the local `sh` transport. It bundles with esbuild on the fly (the QuickJS side with `scripts/bundle.js`, exactly as shipped) and is skipped where `qjs` is not installed (`brew install quickjs`). Shared test code goes under `src/tests/helpers/`, which ava does not treat as test files. A platform difference users can see, such as a file error's wording, should be normalised in the platforms rather than tolerated here.

`hardware.test.ts` covers the hardware abstraction one rule at a time with small made-up device schemas (`*`/`*t` ports, `@cpu_port`, `bridge-vlan` and `switch_vlan`, radio fan-out by band, distinct names for two radios in one band); `hardwareSnapshots.test.ts` snapshots the sample config's UCI commands on the two captured real devices, so a change to that logic shows up as a snapshot diff (`npx ava --update-snapshots` when intended). `provisionNetwork.test.ts` drives the phases against `src/tests/helpers/fakeDevice.ts` — a device that speaks the tool's protocol, keeps a small UCI model it applies the staged `uci batch` to (so verification reads back what the batch really did), and records what happens to it — on a virtual clock (the run takes `now` and `sleep`), so failure paths are tested without Docker.

CI (`.github/workflows/test.yml`, on push to `main` and on pull requests; the release workflow calls it as its gate) runs the tests, `npm run typecheck`, and the rig. It builds `qjs` through the `setup-quickjs` composite action (`scripts/install-quickjs.sh`) — exactly the version OpenWrt 25.12 ships, hash-pinned — and the parity test *fails* rather than skips when `CI` is set and `qjs` is missing. ava's timeout is 2 min: the parity tests run processes synchronously and are slow on emulated or loaded runners.

**Testing provision without a real device.** `scripts/rig-test.sh` automates all of this and runs in CI: each SSH client path gets its own device and controller, in parallel; the router path (`dbclient`) gets every scenario, the others those where their client behaves differently. It sets `ONC_TEST_MIN_CONFIRM_WINDOW=15` with `--confirm-timeout 30` so rollbacks do not wait out the real window — no shorter, or the settle step's reserve for the final reconnect leaves it no time and it is skipped, which is exactly the check the wipe scenario exercises. On Apple Silicon it uses the native `armsr-armv8` rootfs, which is labelled `linux/aarch64_generic` so it must run with no `--platform`. `openwrt/rootfs:x86-64-v25.12.5` boots fully under Docker with `--privileged ... /sbin/init` (procd, ubusd, netifd, dropbear, a real `board.json` with model `orbstack,virt` under OrbStack). netifd moves eth0 into `br-lan` at 192.168.1.1, so set `network.lan` to the container's Docker address on `eth0` directly. OrbStack does not route the Mac to container IPs, so run the tool from a second container on the same network: another OpenWrt rootfs with `apk add quickjs` (dbclient path; delete `/usr/bin/dbclient` and `apk add openssh-client` for the OpenSSH path), or `node:24-alpine` with `NODE_PATH` at the repo's `node_modules`. A config that does not declare `dropbear` must list it in `configs_to_not_reset`, or the declarative reset deletes its section and the rig locks itself out — which is how the settle bug above was found. Wait for `board.json` (generated late in boot), not just for dropbear and netifd, which are up almost at once.

## Gotchas

- **The CLI version is duplicated.** `package.json` `version` and the `version` in the spec in `src/cli.ts` must be bumped together.
- **Releases are tag-driven.** `.github/workflows/release.yml` fires on a pushed `X.Y.Z` or `vX.Y.Z` tag, runs `test.yml` (tests, typecheck, rig) as a gate, checks the tag against the version, then publishes the binaries, the bundle, the OpenWrt feed and the Homebrew formula (see "Packaging").
- **`print-uci-commands` builds against the live SSH session**, the same as `provision`. It used to call `getDeviceScript({ state })` with no session, so package diffing never ran: every package the config named was printed as an install and every removal as a removal, regardless of what was on the device. That reported a 21-package `apk del` cascade for packages that were not installed at all. Keep the session open until the script is built, or the dry run stops matching what a provision would do. Resolved `$secret` values are redacted in the printed script; `--show-secrets` turns that off — don't pass it unless the user asks.
- **`$secret` refs are resolved once at load** (`loadOncConfig`), before schema parse. The rest of the pipeline still sees plaintext strings. `secrets set` prompts for a value and stores it; there is no `get`.
- **`npm start` is dead.** It points at `./src/index.ts`, which does not exist.
- **`src/config.json` is a stray scratch config**, not used by the tests or the CLI.
- **`images/` is gitignored** — built sysupgrade images bake hostnames and LAN IPs into the artifact.
- **`uci batch` exits 0 even when an operation fails**, reporting the error only on stderr. `getDeviceScript` therefore captures stderr and fails the step if it is non-empty. Don't switch that back to checking the exit code. Only `set`/`add_list` go through the batch — the reset loops stay outside it, because a delete of a missing section is expected there rather than an error.
- **`getInstalledPackages` uses `apk info`**, which prints bare names. It previously parsed `apk list --installed` by splitting on the last `-`, which mangled 86% of names (`curl-8.19.0-r2` → `curl-8.19.0`) so nothing ever matched: removals were silently dropped and installs re-ran every provision.
- **Code style:** heavy functional composition — `reduce`/spread over mutation, arrow-function exports, object-destructured named parameters (`({ oncConfig, deviceConfig })`). Match it. Comments are sparse and explain *why*, usually a device-level quirk worth preserving.
