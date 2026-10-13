// Everything the tool asks a device, as typed probes: a command plus the parse
// of its result. Keeping each question next to its answer's parser means the
// conventions (markers, output formats) live in one place, the parsers can be
// tested against recorded output with no SSH, and several probes can share one
// round trip (runProbes) — which matters under QuickJS, where every round trip
// is a new SSH client process.
//
// The agent's verbs (src/agent) and the transport's exit-status marker are
// not here: they change the device, or wrap commands, rather than ask things.
import { ExecResult, Session } from "./platform";
import { shellQuote } from "./shell";
import { parseJson } from "./utils";
import { parseUciExport, UNREADABLE } from "./engine/uci";

export type Probe<T> = { command: string; parse: (result: ExecResult) => T };

export const runProbe = async <T>(session: Session, probe: Probe<T>) =>
  probe.parse(await session.execCommand(probe.command));

const PROBE_END = "__ONC_PROBE__";

/**
 * Run several probes in one round trip. Each runs in its own subshell, and a
 * marker line carrying its exit status ends its output. Stderr is discarded:
 * it cannot be told apart per probe, so parsers rely on the exit status.
 */
/** What each probe of a set answers, by name. */
export type Answers<P extends Record<string, Probe<unknown>>> = { [K in keyof P]: P[K] extends Probe<infer T> ? T : never };

export const runProbes = async <P extends Record<string, Probe<unknown>>>(session: Session, probes: P): Promise<Answers<P>> => {
  const names = Object.keys(probes);
  const { stdout } = await session.execCommand(
    names
      .map(
        (name) =>
          `( ${probes[name].command}\n) 2>/dev/null; printf '\\n${PROBE_END}%s\\n' "$?"`
      )
      .join("\n")
  );
  // [output, status, output, status, ..., trailing]
  // node-ssh trims its output, so the first marker may not follow a newline
  // and the last may not end with one; the QuickJS transports do not trim.
  const parts = stdout.split(
    new RegExp(`(?:^|\\n)${PROBE_END}(\\d+)(?:\\n|$)`)
  );
  if (parts.length !== names.length * 2 + 1) {
    throw new Error(
      `A device query was cut short (expected ${names.length} answers).`
    );
  }
  return Object.fromEntries(
    names.map((name, i) => [
      name,
      probes[name].parse({
        stdout: parts[i * 2],
        stderr: "",
        code: Number(parts[i * 2 + 1]),
      }),
    ])
  ) as Answers<P>;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// --- what the device is ------------------------------------------------------

/**
 * /etc/board.json as it is: its layout differs across targets and releases,
 * so it is interpreted by the tolerant parser in src/facts/board.ts, not here.
 */
export type BoardJson = { model?: { id?: string; name?: string } } & Record<string, unknown>;

export const boardJson: Probe<BoardJson> = {
  command: "cat /etc/board.json",
  parse: ({ stdout, code }) => {
    if (code !== 0 || !stdout) {
      throw new Error("Failed to read /etc/board.json from the device.");
    }
    const board = parseJson(stdout, "/etc/board.json");
    // Only its shape is assumed here; every field is read tolerantly after.
    if (!board || typeof board !== "object" || Array.isArray(board)) throw new Error("/etc/board.json is not an object.");
    return board as BoardJson;
  },
};

/** The model, board and release, from procd: OpenWrt's stable JSON for them. */
export const systemBoard: Probe<unknown> = {
  command: "ubus call system board",
  parse: ({ stdout, code }) => {
    if (code !== 0 || !stdout) throw new Error("Failed to read ubus system board from the device.");
    return parseJson(stdout, "ubus call system board");
  },
};

/**
 * Which wiphys can be a mesh point (802.11s), by name: { "phy0": true }.
 * Through ucode's nl80211 module, which 25.12 ships for its own Wi-Fi
 * scripts (iw may be absent). Nothing where ucode is missing: unknown.
 */
export const meshSupport: Probe<unknown> = {
  command: `ucode -e 'import * as nl from "nl80211"; let d = nl.request(nl.const.NL80211_CMD_GET_WIPHY, nl.const.NLM_F_DUMP, { split_wiphy_dump: true }) ?? []; let n = {}, m = {}; for (let w in d) { if (w.wiphy_name) n[w.wiphy] = w.wiphy_name; if (w.supported_iftypes) m[w.wiphy] = m[w.wiphy] || !!w.supported_iftypes.mesh_point; } let o = {}; for (let i in n) o[n[i]] = !!m[i]; print(o);' 2>/dev/null || echo '{}'`,
  parse: ({ stdout }) => parseJson(stdout.trim() || "{}"),
};

/** The wifi-device sections, for a device whose board.json has no `wlan`. */
export const radios: Probe<unknown> = {
  command: `ubus call uci get '{"config": "wireless", "type": "wifi-device"}' || echo '{"values":{}}'`,
  parse: ({ stdout }) => parseJson(stdout || '{"values":{}}'),
};

/**
 * Every config on the device, staged changes included, one `uci export` per
 * file: a full `uci export` skips a config it cannot parse and still exits 0,
 * so the only sign would be on stderr. A file whose name uci cannot address
 * (`dhcp.apk-new`) is inert and skipped.
 */
export const uciConfigs: Probe<ReturnType<typeof parseUciExport>> = {
  command: `for f in /etc/config/*; do [ -f "$f" ] || continue; c="\${f##*/}"; case "$c" in *[!A-Za-z0-9_-]*) continue ;; esac; uci export "$c" 2>/dev/null || printf '\\n${UNREADABLE} %s\\n' "$c"; done`,
  parse: ({ stdout }) => parseUciExport(stdout),
};

// --- what is on it -----------------------------------------------------------

/**
 * Names of the packages installed on the device.
 *
 * Uses `apk info`, which prints one bare package name per line. The previous
 * approach parsed `apk list --installed` by splitting on the last "-", which
 * silently mangled any name carrying an apk release suffix: `curl-8.19.0-r2`
 * parsed as name "curl-8.19.0", version "r2". That mis-parsed 86% of packages
 * on a stock 25.12 install, so the installed-set comparisons never matched:
 * removals were filtered away entirely and installs were re-issued on every
 * provision.
 */
export const installedPackages: Probe<string[]> = {
  command: "apk info",
  parse: ({ stdout, code }) => {
    // 127: no apk at all, so nothing is installed through it.
    if (code === 127) return [];
    if (code !== 0) throw new Error("Failed to get installed packages");
    return lines(stdout);
  },
};

/** The files a previous provision wrote, from its manifest. */
export const managedFiles = (manifestPath: string): Probe<string[]> => ({
  command: `cat ${shellQuote(manifestPath)}`,
  parse: ({ stdout, code }) => (code === 0 ? lines(stdout) : []),
});

/**
 * Everything `apk del --rdepends` would actually take with it.
 *
 * The named packages are only the start: `--rdepends` also removes whatever
 * depends on them (removing `firewall4` takes LuCI's firewall app and the
 * `luci` meta-packages with it on 25.12.5). Reporting only what the config
 * names would understate that, so ask apk to simulate it. A simulation that
 * fails or cannot be read is an error, never the named packages alone: the
 * cascade is what gets staged for a rollback, and a removal that cannot be
 * staged is refused.
 */
export const removalCascade = (packages: string[]): Probe<string[]> => ({
  command: `apk del --simulate --rdepends ${packages
    .map(shellQuote)
    .join(" ")}`,
  parse: ({ stdout, code }) => {
    const cascade = stdout
      .split("\n")
      .map((line) => line.match(/^\(\s*\d+\/\d+\)\s+Purging\s+(\S+)\s/))
      .flatMap((match) => (match ? [match[1]] : []));
    if (code !== 0 || cascade.length === 0) {
      throw new Error(`Could not work out what removing ${packages.join(", ")} would take with it (apk del --simulate).`);
    }
    return cascade;
  },
});

/** "OK: 12.8 MiB in 155 packages" (apk 3's last line) → KiB, or undefined. */
export const apkTotalKb = (line: string): number | undefined => {
  const m = /OK:\s+([\d.]+)\s*(B|KiB|MiB|GiB)\b/.exec(line);
  if (!m) return undefined;
  const scale = { B: 1 / 1024, KiB: 1, MiB: 1024, GiB: 1024 * 1024 }[m[2] as "B" | "KiB" | "MiB" | "GiB"];
  return Number(m[1]) * scale;
};

export type PackageSpace = { needKb: number; freeKb: number };

/**
 * What a run's packages would take of the flash, before any is touched: the
 * installed total now, after the removals and after the additions (apk's own
 * simulation, with a fresh index as prepare uses), against the overlay's free
 * space. Installed sizes are uncompressed and the overlay compresses, so it
 * errs on the safe side. Undefined when apk cannot say (no index reachable):
 * the install would then fail on its own, with nothing changed yet.
 */
export const packageSpace = ({ add, remove }: { add: string[]; remove: string[] }): Probe<PackageSpace | undefined> => ({
  command: [
    "apk update > /dev/null 2>&1",
    "apk add --simulate 2>&1 | tail -n 1",
    remove.length ? `apk del --simulate --rdepends ${remove.map(shellQuote).join(" ")} 2>&1 | tail -n 1` : "apk add --simulate 2>&1 | tail -n 1",
    `apk add --simulate ${add.map(shellQuote).join(" ")} 2>&1 | tail -n 1`,
    "{ df -k /overlay 2> /dev/null || df -k /; } | tail -n 1",
  ].join("; "),
  parse: ({ stdout }) => {
    const [now, afterRemove, afterAdd, df] = lines(stdout);
    const totals = [now, afterRemove, afterAdd].map((line) => apkTotalKb(line ?? ""));
    const freeKb = Number((df ?? "").trim().split(/\s+/)[3]);
    if (totals.some((t) => t === undefined) || !Number.isFinite(freeKb)) return undefined;
    const [n, r, a] = totals as number[];
    return { needKb: Math.max(0, a - n + (r - n)), freeKb };
  },
});

/** The MACs of every Wi-Fi client associated with the device now, lower case. */
export const wifiStations: Probe<string[]> = {
  command:
    'for d in /sys/class/net/*/phy80211; do [ -e "$d" ] || continue; i=${d%/phy80211}; iwinfo "${i##*/}" assoclist 2> /dev/null; done',
  parse: ({ stdout }) => [
    ...new Set(lines(stdout).flatMap((line) => (/^([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s/.exec(line)?.[1].toLowerCase() ?? []))),
  ],
};

/**
 * Per service procd knows: the configs its reload triggers watch (each a
 * `["eq", "package", <config>]` in its triggers). A service without one for
 * its config ignores a change to it until restarted.
 */
export const serviceTriggers: Probe<Record<string, string[]>> = {
  command: `ubus call service list '{"verbose":true}'`,
  parse: ({ stdout }) => {
    const watched = (value: unknown): string[] =>
      Array.isArray(value)
        ? value[0] === "eq" && value[1] === "package" && typeof value[2] === "string"
          ? [value[2]]
          : value.flatMap(watched)
        : [];
    try {
      const services = JSON.parse(stdout) as Record<string, { triggers?: unknown }>;
      return Object.fromEntries(Object.entries(services).map(([name, s]) => [name, [...new Set(watched(s?.triggers))]]));
    } catch {
      return {};
    }
  },
};

/** The configs the device has (/etc/config's files). */
export const configNames: Probe<string[]> = {
  command: "ls -1 /etc/config",
  parse: ({ stdout }) => lines(stdout).filter((name) => /^[A-Za-z0-9_-]+$/.test(name)),
};

/** Files of `paths` the device does not have. */
export const missingFiles = (paths: string[]): Probe<string[]> => ({
  command: paths.length ? `for f in ${paths.map(shellQuote).join(" ")}; do [ -e "$f" ] || echo "$f"; done` : "true",
  parse: ({ stdout }) => lines(stdout).filter((path) => paths.includes(path)),
});

/**
 * How many staged UCI changes each package has pending. Counts only, never
 * the changes: a staged value can be a secret (a Wi-Fi key, say).
 */
export const summarisePendingChanges = (uciChanges: string) =>
  lines(uciChanges).reduce<Record<string, number>>((counts, line) => {
    const pkg = line.replace(/^[-+]/, "").split(/[.=]/)[0];
    return { ...counts, [pkg]: (counts[pkg] ?? 0) + 1 };
  }, {});

export const pendingChanges: Probe<Record<string, number>> = {
  command: "uci changes",
  parse: ({ stdout }) => summarisePendingChanges(stdout),
};

// --- during a provision ------------------------------------------------------

/**
 * Whether `host` still answers SSH, checked from the device itself.
 *
 * Busybox `nc` on a stock image has no timeout or scan flag, so it is killed
 * after two seconds; dropbear sends its `SSH-` banner on accept, before any
 * client input, so a listening server is visible in that time.
 */
export const answersSsh = (host: string, port = 22): Probe<boolean> => ({
  command:
    `out=$( { nc ${shellQuote(
      host
    )} ${port} </dev/null & p=$!; sleep 2; kill $p; } 2>/dev/null ); ` +
    `case "$out" in SSH-*) echo ONC_SSH_OK ;; *) echo ONC_SSH_DOWN ;; esac`,
  parse: ({ stdout }) => stdout.includes("ONC_SSH_OK"),
});

/**
 * Block on the device until procd's service table stops changing.
 *
 * reload_config only signals services: procd runs each reload trigger after
 * PROCD_RELOAD_DELAY (1 s), and the service then restarts its instances.
 * Reconnecting straight after the commit could land while the old dropbear was
 * still listening, and confirm a config that stopped it a second later — that
 * happened on the test rig. `ubus call service list` carries every instance's
 * pid and parameters, so three unchanged seconds in a row mean the reloads have
 * landed. Bounded, since a service that keeps restarting must not stall the
 * confirm past its window.
 */
export const servicesSettled = (maxSeconds: number): Probe<void> => ({
  command: [
    "prev=; same=0; n=0",
    `while [ $n -lt ${Math.max(1, Math.floor(maxSeconds))} ]; do`,
    "  cur=$(ubus call service list 2>/dev/null | md5sum)",
    '  if [ "$cur" = "$prev" ]; then same=$((same+1)); [ $same -ge 3 ] && break; else same=0; fi',
    "  prev=$cur; n=$((n+1)); sleep 1",
    "done",
  ].join("\n"),
  parse: () => undefined,
});

/**
 * Which of `names` have no running process, as procd sees it ("missing": no
 * init script at all). Only the counts leave the device: a service's
 * command line can carry config values.
 */
export const notRunning = (names: string[]): Probe<{ name: string; missing: boolean }[]> => ({
  command: names.length
    ? [
        `for s in ${names.map(shellQuote).join(" ")}; do`,
        '  [ -x "/etc/init.d/$s" ] || { echo "$s -"; continue; }',
        `  printf '%s %s\\n' "$s" "$(ubus call service list '{"name":"'"$s"'"}' 2>/dev/null | jsonfilter -e '@.*.instances.*.running' 2>/dev/null | grep -c true)"`,
        "done",
      ].join("\n")
    : "true",
  parse: ({ stdout }) =>
    lines(stdout).flatMap((line) => {
      const [name, count] = line.split(" ");
      return names.includes(name) && (count === "-" || count === "0")
        ? [{ name, missing: count === "-" }]
        : [];
    }),
});
