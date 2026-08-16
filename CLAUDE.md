# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Never read secrets from config files

**This is the highest-priority rule in this file. It overrides convenience, debugging, and "I just need to see the shape of it."**

Real network config files in this repo contain live credentials: SSH root passwords (`provisioning_config.ssh_auth.password`), Wi-Fi PSKs (`key` on `wifi-iface` sections), PPPoE credentials (`username`/`password` on `interface` sections), and DDNS/VPN tokens.

Do **not** open, `cat`, `grep`, print, or otherwise pull the contents of:

- `*.config.json` at the repo root (e.g. `stellenberg.config.json`) — gitignored, mode `0600`, real.
- Anything under `configs/` — gitignored, and a separate nested git repo of the user's live network configs.
- Any file the user points at as "my config" / "my network config", wherever it lives.

If you need to understand config *structure*, use the committed fixtures instead — they contain only placeholder secrets:

- `sampleConfigs/basic.json`
- `src/tests/main/config.json`, `src/tests/main/config2.json`
- `README.md` (documents every top-level key with examples)

If a task genuinely cannot proceed without something in a real config file, stop and ask the user to paste the specific non-secret value. Never dump the file to find it.

Corollaries: don't echo a secret you happened to encounter, don't write one into a test fixture, commit message, log line, or scratch file, and don't add code that logs `ssh_auth` or wireless `key` values.

## Never provision without being asked

`provision` connects over SSH to real routers and access points and rewrites their UCI config. A bad config can drop the network or lock the user out of a device mid-run.

- Never run `npm run provision`, `build-images` (non-dry-run), or the built binary against real devices unless the user explicitly asks in that message.
- `print-uci-commands` is read-only *on the device*, but it still opens an SSH connection to introspect it (see "Device schemas are introspected live"). Treat it as a network action, not a local one.
- The only fully offline commands are `npm test`, `npm run build`, and `build-images --dry-run` (which only reaches out to the OpenWrt ASU API for profile resolution, and tolerates that failing).

## What this project is

A CLI that takes one UCI-like JSON file describing an entire network — every device, its packages, firmware version, UCI config and arbitrary files — and provisions it to OpenWrt devices over SSH. The JSON is conditionally composed with `.if` / `.overrides` keys so a single file drives routers, switches and dumb APs of different models.

Published to GitHub Releases as standalone binaries (macOS/Linux/Windows) via `@yao-pkg/pkg`.

## Commands

```sh
npm test                 # ava; 8 tests, all offline
npm run test:watch
npm run build            # tsc -> ./dist
npm run package          # pkg -> ./artifacts (needs npm run build first)

# Against real devices — only on explicit request:
npm run provision          <config-file>
npm run print-uci-commands <config-file>
npm run build-images       <config-file> [--dry-run] [--out ./images] [--concurrency 3]
```

Node 24 (`.node-version`), TypeScript 6, CommonJS. `ts-node --transpile-only` for the dev scripts, so type errors do **not** surface there — run `npm run build` to typecheck.

## Architecture

The pipeline, in dependency order:

1. **`bin/index.ts`** — commander CLI. Reads the config file, `parseJson` (via `parse-json`, for good error positions), then `parseSchema(oncConfigSchema, ...)`.
2. **`src/oncConfigSchema.ts`** — zod schema for the *input* JSON ("ONC config"): `version`, `devices`, `package_profiles`, `files`, `configs_to_not_reset`, `config`. `.strict()` throughout, so unknown keys are hard errors by design.
3. **`src/getDeviceSchema.ts`** — builds a `DeviceSchema` (ports, radios, CPU port, existing UCI section types, firmware version) for each device.
4. **`src/resolveOncConfig.ts`** — collapses `.if` / `.overrides` for one device. `conditionMatches` evaluates conditions against `device.tag.*`, `device.hostname`, `device.ipaddr`, `device.model_id`, `device.version`, `device.sw_config`, using `boolean-parser` for `AND`/`OR` and hand-rolled `==` / `!=`.
5. **`src/getOpenWrtConfig.ts`** — the interesting one. Turns abstractions into concrete UCI: expands `@cpu_port`, resolves `"*"` / `"*t"` port wildcards to actual unused physical ports, maps `bridge-vlan` (DSA) vs `switch_vlan` (legacy swconfig) depending on `deviceSchema.sw_config`, assigns `.name`s, injects the hostname, and expands `wifi-iface` across radios by band.
6. **`src/getOpenWrtState.ts`** — adds packages to install/uninstall, which config sections to reset, and resolved `files`.
7. **`src/getUciCommands.ts`** + **`src/getDeviceScript.ts`** — emit the shell script. Fixed order: `uci revert` of every touched config (clean start, see below) → package install/removal → `reload_config` (baseline refresh, see below) → section resets → one `uci batch` carrying every `set`/`add_list` → file writes (each with its optional `run_after`) → `uci commit` per touched config → `reload_config` → each `run_after_reload`.
8. **`src/execScript.ts`** — runs the whole command list as one script piped to `sh` over **stdin**. Do not "simplify" this into a single joined exec string: dropbear rejects exec requests over ~9 KB and drops the connection on larger ones, while a real provision script is comfortably past that. `set -e` plus a marker echoed after each command preserves per-command failure granularity.
9. **`src/provisionOpenWrtDevice.ts`** — verifies the board id, warns about package removals, arms a commit-confirm watchdog, runs the script, commits, then reconnects to confirm. On failure it runs `getRevertCommands(state)` (`uci revert` for *every* config the state touches, not just the built-in five) and aborts. Files are deliberately written *before* `uci commit` so a write failure leaves the revert effective.

### Commit-confirm

Because committing `network`/`firewall` can sever the connection doing the provisioning, `provision` snapshots state, starts a detached `setsid` watchdog, commits, then reconnects (retrying, since `reload_config` briefly drops the network) and touches its confirm flag to disarm it. If the tool cannot get back in, the device rolls back and reboots itself. `--no-confirm` disables it; `--confirm-timeout` changes the 90 s window.

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

### The commit names each config, and each run starts clean

The script commits `uci commit <pkg>` per touched config rather than a bare `uci commit`, because a bare commit commits *every* package — including staged changes this tool never made, such as a half-finished LuCI edit or leftovers from an earlier failed run.

It also `uci revert`s those same configs before staging anything. A run that dies before it can revert — the link drops mid-configure, so the tool's own revert never reaches the device — leaves its deltas in `/tmp/.uci`, and the watchdog restores `/etc/config` without touching the delta directory. Those changes survive the rollback, and a later commit would apply them. Reverting up front fixes that deterministically rather than racing an abandoned script that may still be running. It has to come *before* the packages step, because `default_postinst` ends with a bare `uci commit` for any package shipping `/etc/uci-defaults`.

Both are guarded with `if [ -f /etc/config/<pkg> ]`: `uci commit` and `uci revert` both exit 1 on a config that is not present (verified on 25.12.5) and the script runs under `set -e`, so one absent config would otherwise abort the provision — or, in `getRevertCommands`, stop every remaining revert partway through a rollback.

`getFinaliseCommands(state)` is derived from state rather than being a constant, so `provisionOpenWrtDevice` must use it (not a fixed length) to split the configure phase from the finalise phase.

### Dropbear does not kill your command

When the connection drops, dropbear does **not** signal the running command — its only `kill()` is for an explicit client signal request, there is no `setsid`/`setpgid`, and a non-pty exec has no controlling terminal. OpenWrt defaults are `SSHKeepAlive:300`, `IdleTimeout:0`, so it may not even notice a blackholed peer for five minutes. Measured on 25.12.5: a remote loop writing only to a file finished 12/12 iterations after its client was killed; an identical loop writing to stdout died at 3/12.

Two consequences. The commit step is safe — `reload_config` writes nothing to stdout, so it runs to completion even if committing severs the link. But the per-command marker in `execScript` means the configure phase dies by SIGPIPE within about one command of a *clean* disconnect, and on a blackholed network an abandoned script can keep executing for up to `SSHKeepAlive` while the watchdog is already restoring `/etc/config`.

### Two parallel schema hierarchies

Under `src/configSchemas/<package>/`, every UCI section has **two** zod schemas:

- `networkInterfaceSchema` — the strict *output* shape, used by `openWrtConfigSchema` to validate what gets turned into `uci` commands.
- `oncNetworkInterfaceSchema` — the *input* shape: same fields, but `.partial()` and extended with `.if` / `.overrides` / `.name`.

The `index.ts` in each package folder wires them up with helpers from `src/utils.ts` (`sectionSchema`, `oncSectionSchema`, `configSchema`, `makeOncConfigSchema`, `getExtensionObject`) and exports a `<package>SectionsToReset` map.

**Adding support for a new UCI option means editing both schemas.** Adding a whole new section type also means adding it to that package's `index.ts` and its `SectionsToReset` map, or it will never be reset and will duplicate on every provision.

### Device schemas are introspected live

`getDeviceSchema` normally SSHes into the device and derives everything from it:

- `/etc/board.json` → ports, and whether the device is legacy swconfig (`.switch` present) or DSA.
- `ubus call uci get '{"config":"wireless","type":"wifi-device"}'` → radios (band, path, type).
- `uci export` → existing section types per package (`src/getConfigSections.ts`).
- `/etc/openwrt_release` → `DISTRIB_RELEASE`.

The checked-in `deviceSchemas/*.json` files are only used when `useLocal` is passed (or the `useLocalOverride` constant in `getDeviceSchema.ts` is flipped) — that path exists for the tests and local experimentation, and only covers two old models. Don't assume it's the normal path.

### Managed files

`files` entries are written via a quoted heredoc (not `base64` — busybox on small-flash builds often lacks the applet). The set of written paths is recorded in `/etc/onc/managed_files` on the device, so a file removed from the config is `rm -f`'d on the next provision. `run_after` runs immediately after the write.

## Tests

`ava` with `ts-node/register/transpile-only`, in `src/tests/main/`. Note ava's default glob picks up **everything** under a `tests/` directory, so `network2.ts` is a test file despite the missing `.test` suffix.

Most tests are golden-ish: load `config.json` / `config2.json`, build the OpenWrt config against a local device schema, and assert on the resulting structure. `files.test.ts` and `getConfigSections.test.ts` are focused unit tests. All are offline — no test touches the network.

## Gotchas

- **The CLI version is duplicated.** `package.json` `version` and the hardcoded `.version("0.0.6")` in `bin/index.ts` must be bumped together.
- **Releases are tag-driven.** `.github/workflows/release.yml` fires on a pushed `X.Y.Z` or `vX.Y.Z` tag, runs build + package, and publishes binaries with sha256 sums. Nothing runs on push to `main` — there is no CI test run, so run `npm test` yourself.
- **`print-uci-commands` builds against the live SSH session**, the same as `provision`. It used to call `getDeviceScript({ state })` with no session, so package diffing never ran: every package the config named was printed as an install and every removal as a removal, regardless of what was on the device. That reported a 21-package `apk del` cascade for packages that were not installed at all. Keep the session open until the script is built, or the dry run stops matching what a provision would do.
- **`npm start` is dead.** It points at `./src/index.ts`, which does not exist.
- **`src/config.json` is a stray scratch config**, not used by the tests or the CLI.
- **`images/` is gitignored** — built sysupgrade images bake hostnames and LAN IPs into the artifact.
- **`uci batch` exits 0 even when an operation fails**, reporting the error only on stderr. `getDeviceScript` therefore captures stderr and fails the step if it is non-empty. Don't switch that back to checking the exit code. Only `set`/`add_list` go through the batch — the reset loops stay outside it, because a delete of a missing section is expected there rather than an error.
- **`getInstalledPackages` uses `apk info`**, which prints bare names. It previously parsed `apk list --installed` by splitting on the last `-`, which mangled 86% of names (`curl-8.19.0-r2` → `curl-8.19.0`) so nothing ever matched: removals were silently dropped and installs re-ran every provision.
- **`parseSections` dedupes section types per-package, not globally** (see the comment in `src/getConfigSections.ts`). A global dedupe silently breaks packages that share a section type name, e.g. `defaults` in both `firewall` and `qosify`. Don't "simplify" it back.
- **Code style:** heavy functional composition — `reduce`/spread over mutation, arrow-function exports, object-destructured named parameters (`({ oncConfig, deviceConfig })`). Match it. Comments are sparse and explain *why*, usually a device-level quirk worth preserving.
