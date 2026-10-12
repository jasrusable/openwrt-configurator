// Everything the tool asks a device, as typed probes: a command plus the parse
// of its result. Keeping each question next to its answer's parser means the
// conventions (markers, output formats) live in one place, the parsers can be
// tested against recorded output with no SSH, and several probes can share one
// round trip (runProbes) — which matters under QuickJS, where every round trip
// is a new SSH client process.
//
// The script protocol (execScript's per-command markers) and the transport's
// exit-status marker are not here: they wrap commands rather than ask things.
import { ExecResult, Session } from "./platform";
import { shellQuote } from "./shell";
import { stagedScriptPath } from "./execScript";
import { parseJson } from "./utils";
import { parseUciExport, UNREADABLE } from "./uci";

export type Probe<T> = { command: string; parse: (result: ExecResult) => T };

export const runProbe = async <T>(session: Session, probe: Probe<T>) =>
  probe.parse(await session.execCommand(probe.command));

const PROBE_END = "__ONC_PROBE__";

/**
 * Run several probes in one round trip. Each runs in its own subshell, and a
 * marker line carrying its exit status ends its output. Stderr is discarded:
 * it cannot be told apart per probe, so parsers rely on the exit status.
 */
export const runProbes = async <P extends Record<string, Probe<unknown>>>(
  session: Session,
  probes: P
): Promise<{ [K in keyof P]: P[K] extends Probe<infer T> ? T : never }> => {
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
  ) as any;
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
export const boardJson: Probe<{ model?: { id?: string; name?: string } } & Record<string, unknown>> = {
  command: "cat /etc/board.json",
  parse: ({ stdout, code }) => {
    if (code !== 0 || !stdout) {
      throw new Error("Failed to read /etc/board.json from the device.");
    }
    return parseJson(stdout, "/etc/board.json") as any;
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
 * depends on them. Removing `firewall4` on a stock image pulls 21 packages,
 * `uhttpd` and the whole LuCI stack among them. Reporting only what the config
 * names would understate that badly, so ask apk to simulate it.
 */
export const removalCascade = (packages: string[]): Probe<string[]> => ({
  command: `apk del --simulate --rdepends ${packages
    .map(shellQuote)
    .join(" ")}`,
  parse: ({ stdout }) => {
    const cascade = stdout
      .split("\n")
      .map((line) => line.match(/^\(\s*\d+\/\d+\)\s+Purging\s+(\S+)\s/))
      .flatMap((match) => (match ? [match[1]] : []));
    // If the simulation could not be parsed, fall back to the named packages
    // rather than reporting an empty, falsely reassuring list.
    return cascade.length > 0 ? cascade : packages;
  },
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

/** Packages fetched into the rollback directory, for an offline reinstall. */
export const stagedPackageCount = (dir: string): Probe<number> => ({
  command: `ls ${shellQuote(dir)}/*.apk 2>/dev/null | wc -l`,
  parse: ({ stdout }) => Number(stdout.trim()) || 0,
});

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

/**
 * Stand the rollback watchdog down; true if it is verifiably stopped.
 *
 * Touch the flag first so the watchdog disarms even if the kill fails, then
 * kill it outright: the flag is only read after its sleep ends, which leaves a
 * window where it could fire between the check and the touch. Killing it
 * mid-sleep is decisive rather than advisory. The staged script is normally
 * removed by the run that executes it, but a run cut short by the commit
 * severing the connection leaves it behind, and it embeds config values.
 */
export const disarmWatchdog = ({
  confirmFlag,
  pidFile,
  sleepPidFile,
}: {
  confirmFlag: string;
  pidFile: string;
  sleepPidFile: string;
}): Probe<boolean> => {
  return {
    command: [
      `touch ${confirmFlag}`,
      `kill "$(cat ${pidFile} 2>/dev/null)" "$(cat ${sleepPidFile} 2>/dev/null)" 2>/dev/null`,
      `rm -f ${stagedScriptPath}`,
      `if [ -f ${pidFile} ] && kill -0 "$(cat ${pidFile})" 2>/dev/null; then echo ONC_ARMED; else echo ONC_DISARMED; fi`,
    ].join("; "),
    parse: ({ stdout }) => stdout.includes("ONC_DISARMED"),
  };
};
