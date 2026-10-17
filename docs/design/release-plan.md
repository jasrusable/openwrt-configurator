# Release, deployment and upgrades

Planned 2026-10-17. Audience: the OpenWrt forums, publicly. The app runs in
one place per network, on the router or on a separate Linux machine, never
both. Linux servers (a Raspberry Pi, a NAS, a VM) are first class.

## Principles

1. **Nothing changes a device without an Apply.** Updating the app updates
   the app; what the new version would write differently is shown in the
   Apply sheet as "App update" lines (already built), applied when you
   choose.
2. **Every update can be undone.** The app's previous version stays
   installable, and a settings file migrated by an update is kept as it was.
3. **One manager per network.** Each device knows which installation manages
   it; another is refused until it takes over, on purpose.
4. **A release is gated on what it does to devices,** not only on tests: the
   compiled output for real settings files is compared with the last release,
   and every difference is either expected and described, or a failure.
5. **Forum users arrive with a configured router.** The first apply replaces
   its configuration entirely (the wipe), so the first run has to back it up,
   say so plainly, and be reversible.

## Where it runs

| Install | For | How | Updates |
|---|---|---|---|
| Router package | most users | the signed apk feed: an install line that adds the feed's key (fingerprint shown in the README) and `apk add openwrt-configurator`; later, firmware images that include it (ASU, `firmware/builds.ts` already builds images) | one click in the app |
| Linux server, Docker | a Pi, a NAS, a VM | a multi-arch image (`linux/amd64`, `linux/arm64`, `linux/arm/v7`) on ghcr.io: the bundle on Node 24, data in one volume | the app says a version is out and gives the command (or Watchtower) |
| Linux server, plain | people without Docker | the single-file bundle (`openwrt-configurator.mjs`) on the system's Node 24, a systemd unit, an install script | one click: download, check the signature, replace, restart |
| macOS | trying it, development | Homebrew (the bundle on Node) | `brew upgrade` |

The `pkg` binaries go: pkg is archived upstream, and its Linux binary is x64
only (no Pi). The bundle already runs under Node and QuickJS on every
architecture; Windows is dropped until someone asks.

## Server mode (new)

`onc ui` listens on loopback with no login. A Linux server needs:

- `onc serve <intent> --listen <address>`: any address, refused without
  login set up; the Host allowlist (`server/hosts.ts`) and the CSRF Origin
  check (`server/cgi.ts`) apply as on the router.
- Login with the network's own login password (`system.app_login.password`,
  the devices' root password, as the router's login already is), checked by
  the server instead of rpcd; the same per-client slowing and sessions.
- HTTPS optional (a certificate and key path); cookies `Secure` when on it.
  Plain HTTP on the LAN by default, as LuCI.
- Data in one directory (`/var/lib/onc`, the Docker volume): the intent, its
  `.state/`, the app's SSH key and known hosts. Nothing under `$HOME`.
- The collector runs inside the server (as on the Mac), written to disk:
  no flash budget, so the hourly copy is not needed.
- A health endpoint for Docker and systemd.

## One manager per network

- The applied marker on each device (`/etc/onc/applied`) records the
  installation that applied: a random id made at install, beside `site_id`.
- Planning refuses a device another installation applied, naming it: "This
  network is managed from <where>". Take over is explicit (an acknowledgement
  in the Apply sheet), as moving is.
- **Moving between router and server:** export from the old one (System ›
  Backup: the settings file, known hosts, history) and import on the new one;
  the new installation's SSH key must be authorized on every device before
  the old one lets go, so the move is one apply from the old installation
  (adding the key), then take over from the new one.

## Releases

- **Versions:** semver. 0.x until the forums have run it a while; the
  settings format freezes at `schema: 1` with the first public release, and
  every format change from then on is a migration (`intent/migrations.ts`,
  n → n+1).
- **Channels:** stable and beta. A tag `vX.Y.Z` publishes to stable,
  `vX.Y.Z-beta.N` to beta; each has its own feed path and Docker tag. A
  setting in System › Updates picks one.
- **Gates, in CI on every tag** (beside today's tests and rig):
  - **Settings from every release still load:** `src/tests/released/<version>/`
    holds settings files saved by each released version (the sample, the
    generative corpus' seeds, captured boards), each loaded, migrated,
    checked and compiled by the new one.
  - **Devices change only as described:** `npm run equivalence -- <last
    release tag>` over that corpus; changes made on purpose are listed in
    `scripts/equivalence.expected.json` with a sentence each, and that list
    becomes the release notes' "Changes on your devices".
  - **Upgrade in the rig:** the last release installed and applied, then the
    new package installed over it and applied again (no failure, only the
    expected changes).
- **Release notes** in `CHANGELOG.md`, shown in the app before updating:
  what is new, changes on your devices, anything to do by hand.
- **The feed keeps the last three versions** of each channel (GitHub Pages
  is replaced whole each release: the job copies the previous index's
  packages forward), so a version can be gone back to.
- **Keys:** the feed's signing key and the Docker image's signature
  (cosign, keyless from the workflow) documented, with how a key would be
  rotated (a second key trusted for a release, then the old one dropped).

## Updating the app

- **Knowing:** once a day, beside the firmware check (the collector's hourly
  work): the router reads its feed's index (`apk`), a server the GitHub
  releases API. "Version X is out" in System › Updates and the sidebar's
  update mark (`UpdateDot`, one derivation, as firmware's), with its notes.
- **Router, one click:** the running version's `.apk` is kept
  (`<state>/app/previous.apk`, as `firmware/self.ts` keeps one for
  sysupgrade), then `apk add --upgrade`, the CGI and collector restarted,
  the page reloaded. Undo installs the kept package offline.
- **Plain Linux, one click:** the new bundle downloaded beside the old,
  its signature and sha256 checked, swapped atomically, the service
  restarted by systemd; the old file kept for Undo.
- **Docker:** told, never done: the command, or Watchtower.
- **After any update:** stored files upgrade as read (the store's
  `upgrade`); a settings file of an older format is migrated in memory and
  written only on the next save, keeping `<intent>.pre-<version>.bak` first,
  so going back to the old version restores that file. Then the Apply sheet
  shows the update's device changes, if any.

## Device-side contract

What one version leaves on a device that another must understand: the
applied marker, the rollback boot script (`onc-rollback`), keep.d entries,
the first-boot script in images, hook files, crontab ownership. Each carries
a version; a newer app reads every older one and replaces it on its next
apply; an older app refuses a newer marker rather than guess. Listed in
`src/agent/paths.ts` beside the paths, checked by a test.

## First run for a forum user

- Reading a configured router before the first apply: a full config backup
  of each device (`sysupgrade -b` to this installation's data, never left on
  the device), downloadable, and Undo of the first apply restores it.
- The first apply's sheet says plainly that everything not in these settings
  is replaced, with the list of what goes (the plan's removed sections,
  already computed).
- Supported hardware: the captured boards as a list on the README; any
  other 25.12 device works but is untested.
- A diagnostics bundle for bug reports (versions, facts, the plan, logs,
  secrets left out by the existing redaction) from System, with forum and
  GitHub issue templates asking for it.

## Order

1. Release gates: the released-settings corpus, equivalence against the
   last tag, the rig upgrade test, CHANGELOG, channels. (Before anything
   public: they guard everything after.)
2. Server mode and the Docker image; the bundle replaces the pkg binaries.
3. One manager per network, take over, move.
4. App updates: knowing, one click on the router and plain Linux, Undo.
5. Device-side contract versions.
6. First run backup, the first apply's warning, diagnostics, README and
   forum post.

## Decided

- Updates: notify, one click where the app can do it safely (router, plain
  Linux), the command where it cannot (Docker); never automatic, as an
  update can change what an apply writes.
- The beta channel exists from the first public release.
- Windows and the pkg binaries are dropped.

## Open

- An install line piped to `sh` versus steps to paste: forum users expect
  the line; the README shows both, the key's fingerprint beside them.
- Whether the router package should also be able to serve as the manager
  for a network it is not part of (it can reach the others over SSH now).
