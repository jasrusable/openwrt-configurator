# CLAUDE.md

Guidance for Claude Code when working in this repository: the rules, then a
map. Detail lives next to the code it explains (comments) and in the tests
that guard it; this file says where.

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
npm run print-uci-commands <config-file>
npm run build-images       <config-file> [--dry-run] [--out ./images] [--concurrency 3]
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
`src/loadConfig.ts` reads a file (JSONC, `src/parseJson.ts`), resolves
`$secret` refs (`src/secrets/`: macOS keychain, else `/etc/onc/secrets.json`),
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
  `diff.ts`, `places.ts`, `labels.ts`). `patches/` holds fixes over stock
  OpenWrt, one file each with why, an upstream link and a target.
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
    release: change it freely and hand-edit files.
  - Root's password is `system.app_login.password`, set on every device;
    password login off needs a key, and an apply that would lock this app
    out is refused first (`src/loginAccess.ts`).

### Plan — `src/plan/`, `src/lowLevel/`

The typed value the compiler produces and the engine applies
(`plan/types.ts`): devices, packages `{ add, remove }`, services, files,
keeps `{ config, type?, optional? }`, and sections
`{ name?, when?, options, overrides? }`. Conditions are trees (`when.ts`),
placeholders typed values (`linePort`, `cpuPort`, `freePorts`,
`bridgePorts`, `eachBridgePort`, `allRadios`, `bestMode`, `stations`), and
`positions.ts` says where each may stand. `check.ts`/`rules.ts` validate any
plan. `src/lowLevel/` reads and prints the hand-written JSON (snake_case keys,
`.if` strings via `src/condition.ts`, placeholder strings like `@wan_port`,
`"*"`, `"*t"`); print then parse is the identity, and text that looks like a
placeholder prints with a second `@`.

### Engine — `src/engine/`, `src/getDeviceScript.ts`

Per device: `resolvePlan.ts` (conditions against the device, overrides
merged) → `getOpenWrtConfig.ts` with `ports.ts`, `radios.ts`, `values.ts`
(placeholders fitted to the facts: WAN/line ports, free ports, DSA
`bridge-vlan` vs swconfig `switch_vlan`, radios by band, best `htmode`) →
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
to settle; `provisionConfig.ts` connects and orders devices (gateway and the
local device last, mesh repeaters deepest first: `meshOrder.ts`).

### Agent — `src/agent/`

One fixed POSIX sh script (`script.ts`, its verbs and lessons in its header
comment), written once per run to `/tmp/onc-agent-<runId>.sh`; every step on
the device is a verb with data on stdin (`records.ts`), never argv.
`paths.ts` is the device-side contract other code reads (the mesh rescue
watcher). `index.ts` calls verbs and returns `Result`s.

### Facts, status, store — reading devices

| Plane | What | Owner | Stored |
|---|---|---|---|
| Config | what devices should be | intent → compile → apply | the intent file (the only plane that writes) |
| Facts | model, release, ports, radios, MACs, host key | `getDeviceSchema.ts` probes, `facts/board.ts` parses | `<intent>.state/devices/` (`deviceFacts.ts`) |
| Status | what devices are doing | `status/device/` probes, `status/views.ts`/`network.ts` interpret | the collector's snapshot and history |

- Facts describe hardware and never decide; the compiler never sees facts or
  status. They may grey a UI choice, never refuse it.
- Finding a device (`locate.ts`) fails closed: only the address the settings
  give is trusted on first use; any address the app found itself is tried
  only with a pinned host key, held by the SSH client. New devices come in
  through Hardware › Add (`discover.ts`).
- `status/collector.ts` owns device reads for the Status pages: every 10 s
  while someone looks (a `wanted` mark), once a minute otherwise, never during
  an apply; `/api/status` answers its snapshot. On a router it runs as the
  `onc-collector` procd service, writing to RAM.
- `store.ts`: every file under `<intent>.state/` (paths from `stateLayout`),
  each a key with a zod schema, format and mode, written atomically and
  owner-only; old formats read as nothing unless upgraded. Facts keep their
  pins (address, MACs, host key) across format changes.
- Expected failures are `Result<T, Problem>` (`result.ts`, `problem.ts`: a
  kind plus typed extras); throwing is for bugs.

### Server — `src/server/`

`app.ts` gates every request (frame headers, `X-ONC`, login on a router)
over `router.ts` (routes as data; `respond`/`problemResponse` map a
`Problem` to a status) and one module per area in `api/`. `onc ui` serves it
with Node, loopback only, no login; `onc cgi` answers one request under
uhttpd (`cgi.ts`). `provisionJob.ts` starts an apply as a detached
`provision --job --run-id` process and reads its record (alive while its pid
has its run id on its command line). The UI (`ui/`, React + Mantine) edits
the intent file and nothing else; `ui/src/data/` is its only HTTP code.

### Platforms — `src/platform.ts`, `src/platforms/`

Nothing outside `src/platforms/` imports a Node built-in or touches
`process` (`platformBoundary.test.ts`). One bundle runs under Node and under
QuickJS on a router (`qjsGlobals.ts` first; SSH as a spawned `dbclient` or
OpenSSH per command, exit status from a marker; local mode runs commands with
`sh -c`). Functions take only the `Pick<Platform, …>` they use.

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
- **A fix over stock OpenWrt:** a file in `src/intent/patches/` (why, upstream
  link, target, `releases.before` once fixed upstream).
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
- **The rig:** `scripts/rig-test.sh` provisions OpenWrt 25.12.5 in Docker
  over every SSH client path (`dbclient`, OpenSSH, Node, two devices). On
  Apple Silicon use the `armsr-armv8` rootfs with no `--platform`.
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
- An AP's carried VLAN gets an IPv6 link-local address unless `ipv6 0`
  (`intent/networks/compile.ts`).
- https-dns-proxy, usteer and mwan3 still act when "disabled"; they are
  stopped (`intent/fragment.ts` `serviceWhen`, each feature's compile).
- netifd learns protocol handlers only at start (agent, finalise).
- `apk add --repositories-file /dev/null` installs staged files offline
  (agent, watchdog restore).
- LuCI's unsaved changes are per rpcd session, untouched by `uci revert`
  (agent, `revert_pending`).

## Gotchas

- **Node's stdout into a pipe is asynchronous, and `process.exit` drops what the pipe has not taken**, which cut `compile | jq` off at 64 KiB. The entry point (`bin/index.ts`) makes stdout and stderr blocking first (`blockingStdio`), so `platform.exit` stays synchronous (`never`: callers rely on it); QuickJS flushes in its own `exit`. `cliOutput.test.ts` pipes 200 KB+ through.
- **The CLI version is duplicated.** `package.json` `version` and the `version` in the spec in `src/cli/index.ts` must be bumped together.
- **Releases are tag-driven.** `.github/workflows/release.yml` fires on a pushed `X.Y.Z` or `vX.Y.Z` tag, runs `test.yml` (tests, typecheck, rig) as a gate, checks the tag against the version, then publishes the binaries, the bundle, the OpenWrt feed and the Homebrew formula (see "Packaging").
- **`print-uci-commands` builds against the live SSH session**, the same as `provision`. It used to call `getDeviceScript({ state })` with no session, so package diffing never ran: every package the config named was printed as an install and every removal as a removal, regardless of what was on the device. That reported a 21-package `apk del` cascade for packages that were not installed at all. Keep the session open until the script is built, or the dry run stops matching what a provision would do. Resolved `$secret` values are redacted in the printed script; `--show-secrets` turns that off — don't pass it unless the user asks.
- **`$secret` refs are resolved once at load** (`loadConfig`), before schema parse. The rest of the pipeline still sees plaintext strings. `secrets set` prompts for a value and stores it; there is no `get`.
- **`images/` is gitignored** — built sysupgrade images bake hostnames and LAN IPs into the artifact.
- **`uci batch` exits 0 even when an operation fails**, reporting the error only on stderr. The agent's stage therefore captures its stderr and fails the step if it is non-empty. Don't switch that back to checking the exit code. The wipe's deletes go through the same batch: each names a section read from the device after the prepare step, so a failed one is a real error.
- **The `installedPackages` probe uses `apk info`**, which prints bare names. It previously parsed `apk list --installed` by splitting on the last `-`, which mangled 86% of names (`curl-8.19.0-r2` → `curl-8.19.0`) so nothing ever matched: removals were silently dropped and installs re-ran every provision.
- **Code style:** heavy functional composition — `reduce`/spread over mutation, arrow-function exports, object-destructured named parameters (`({ plan, deviceConfig })`). Match it. Comments are sparse and explain *why*, usually a device-level quirk worth preserving.
