// What an apply changes on each device, as OpenWrt sees it: the device's
// config as it is now (read live, `uci export`) against what the apply leaves
// (the saved intent compiled and resolved with the engine's own code, over the
// wipe and its keep rules), compared as `uci show` lines; plus packages and
// managed files. Read only while the Apply page is open, held in memory,
// never stored. Secret options (Wi-Fi keys, passwords) are compared but their
// values never leave this module.
import { readFacts } from "./deviceFacts";
import { installedPackages, managedFiles, Probe, runProbes, uciConfigs } from "./deviceProbes";
import { managedFilesManifest } from "./getDeviceScript";
import { getOpenWrtState } from "./getOpenWrtState";
import { loadOncConfig } from "./loadConfig";
import { OpenWrtState } from "./openWrtConfigSchema";
import { Platform } from "./platform";
import { provisionableDevices } from "./provisionConfig";
import { readEach } from "./readEach";
import { shellQuote } from "./shell";
import { declaredConfigs, isKept, UciConfigs, UciSection } from "./uci";

export type UciChange = {
  /** As `uci show` prints it: network.lan, or network.lan.ipaddr. */
  key: string;
  before?: string;
  after?: string;
  /** The section `key` was called before: renamed, its options compared under the new name. */
  renamedFrom?: string;
};

export type FileChange = { path: string; change: "added" | "removed" | "changed" };

export type DeviceDiff =
  | {
      hostname: string;
      config: UciChange[];
      packages: { added: string[]; removed: string[] };
      files: FileChange[];
    }
  /** Not reached: what it holds now is not known, so neither is the change. */
  | { hostname: string; error: string };

/**
 * Options whose values are never shown. Matched broadly, since the device's
 * config holds packages' options this app does not know (802.11r's r0kh/r1kh
 * carry keys, WEP has key1-4, acme keeps API tokens in credentials): hiding
 * a harmless one only costs showing "(hidden)".
 */
export const isSecret = (option: string) => /key|secret|pass|psk|token|credential|r[01]kh|priv|auth/i.test(option);

/** What the device holds after the apply: kept sections as they are, declared ones merged in or added. */
export const configsAfter = ({
  current,
  declared,
  keep,
}: {
  current: UciConfigs;
  declared: UciConfigs;
  keep: string[];
}): UciConfigs =>
  Object.fromEntries(
    [...new Set([...Object.keys(current), ...Object.keys(declared)])].flatMap((configKey) => {
      const wants = declared[configKey] ?? [];
      const merged = wants.filter((s) => isKept(keep, configKey, s.type));
      const kept = (current[configKey] ?? [])
        .filter((s) => isKept(keep, configKey, s.type))
        .map((s) => {
          const over = s.name !== undefined ? merged.find((w) => w.name === s.name) : undefined;
          return over ? { ...s, options: { ...s.options, ...over.options } } : s;
        });
      const added = wants.filter(
        (w) => !isKept(keep, configKey, w.type) || !kept.some((s) => s.name !== undefined && s.name === w.name)
      );
      const sections = [...kept, ...added];
      return configKey in current || sections.length > 0 ? [[configKey, sections]] : [];
    })
  );

type Line = { value: string; secret: boolean };

const show = (value: string | string[]) => (Array.isArray(value) ? value : [value]).map((v) => `'${v}'`).join(" ");

/** Each section with its key as `uci show` prints it: anonymous ones as `@type[i]`. */
const keyed = (configs: UciConfigs) =>
  Object.entries(configs).flatMap(([configKey, sections]) => {
    const seen: Record<string, number> = {};
    return sections.map((section: UciSection) => {
      const index = (seen[section.type] = (seen[section.type] ?? -1) + 1);
      return { key: `${configKey}.${section.name ?? `@${section.type}[${index}]`}`, configKey, section };
    });
  });

/** Configs as `uci show` lines, by key. */
export const uciLines = (configs: UciConfigs) => {
  const lines = new Map<string, Line>();
  keyed(configs).forEach(({ key, section }) => {
    lines.set(key, { value: section.type, secret: false });
    Object.entries(section.options).forEach(([option, value]) =>
      lines.set(`${key}.${option}`, { value: show(value), secret: isSecret(option) })
    );
  });
  return lines;
};

const sameValue = (a?: string | string[], b?: string | string[]) =>
  a !== undefined && b !== undefined && show(a) === show(b);

/** How alike two sections' options are: the share with equal values, of all either has. */
const likeness = (a: UciSection, b: UciSection) => {
  const options = [...new Set([...Object.keys(a.options), ...Object.keys(b.options)])];
  return options.length === 0 ? 1 : options.filter((o) => sameValue(a.options[o], b.options[o])).length / options.length;
};

/**
 * Sections that only changed name: one going and one coming, of the same
 * config and type, with at least half their options alike; the likest pairs
 * first. Their options are then compared under the new name, so a rename
 * (the old tool's zone0, LuCI's cfg030f15) reads as one, not as everything
 * removed and added.
 */
export const renames = (before: UciConfigs, after: UciConfigs) => {
  const [was, will] = [keyed(before), keyed(after)];
  const gone = was.filter((b) => !will.some((a) => a.key === b.key));
  const coming = will.filter((a) => !was.some((b) => b.key === a.key));
  const pairs = gone
    .flatMap((b) =>
      coming
        .filter((a) => a.configKey === b.configKey && a.section.type === b.section.type)
        .map((a) => ({ from: b.key, to: a.key, score: likeness(b.section, a.section) }))
    )
    .filter((p) => p.score >= 0.5)
    .sort((x, y) => y.score - x.score);
  return pairs.reduce<{ from: string; to: string }[]>(
    (taken, p) => (taken.some((t) => t.from === p.from || t.to === p.to) ? taken : [...taken, { from: p.from, to: p.to }]),
    []
  );
};

/** `lines` with each renamed section's keys under its new name. */
const renamed = (lines: Map<string, Line>, pairs: { from: string; to: string }[]) =>
  new Map(
    [...lines].map(([key, line]) => {
      const pair = pairs.find((p) => key === p.from || key.startsWith(`${p.from}.`));
      return [pair ? pair.to + key.slice(pair.from.length) : key, line] as const;
    })
  );

const hidden = "(hidden)";

/** The lines that differ, sorted by key; a secret's value only ever as "(hidden)". */
export const diffLines = (before: Map<string, Line>, after: Map<string, Line>): UciChange[] =>
  [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((key) => {
      const a = before.get(key);
      const b = after.get(key);
      if (a?.value === b?.value) return [];
      const shown = (line?: Line) => (line ? (line.secret ? hidden : line.value) : undefined);
      return [{ key, before: shown(a), after: shown(b) }];
    });

/** What a device holds now, as read. */
export type DeviceNow = {
  config: UciConfigs;
  installed: string[];
  /** Files the last apply wrote, from its manifest. */
  managed: string[];
  /** sha256 of each file asked about that exists; "?" where it could not be hashed. */
  hashes: Record<string, string>;
};

/** One device's changes, from what it holds now to what the apply leaves. Pure. */
export const deviceDiff = ({
  hostname,
  state,
  now,
  sha256,
}: {
  hostname: string;
  state: OpenWrtState;
  now: DeviceNow;
  sha256: (text: string) => string;
}): DeviceDiff => {
  const after = configsAfter({
    current: now.config,
    declared: declaredConfigs(state.config),
    keep: state.configsToNotReset ?? [],
  });
  // As the apply writes it: a final newline added where there is none.
  const written = (content: string) => sha256(content.endsWith("\n") ? content : `${content}\n`);
  const files = state.files ?? [];
  const pairs = renames(now.config, after);
  return {
    hostname,
    config: [
      ...pairs.map(({ from, to }): UciChange => ({ key: to, renamedFrom: from })),
      ...diffLines(renamed(uciLines(now.config), pairs), uciLines(after)),
    ].sort((a, b) => a.key.localeCompare(b.key) || (a.renamedFrom ? -1 : 1)),
    packages: {
      added: (state.packagesToInstall ?? []).map((p) => p.packageName).filter((p) => !now.installed.includes(p)),
      removed: (state.packagesToUninstall ?? []).filter((p) => now.installed.includes(p)),
    },
    files: [
      ...files.flatMap((f): FileChange[] =>
        !(f.path in now.hashes)
          ? [{ path: f.path, change: "added" }]
          : now.hashes[f.path] !== written(f.content)
          ? [{ path: f.path, change: "changed" }]
          : []
      ),
      ...now.managed
        .filter((path) => path in now.hashes && !files.some((f) => f.path === path))
        .map((path): FileChange => ({ path, change: "removed" })),
    ].sort((a, b) => a.path.localeCompare(b.path)),
  };
};

/** sha256 of each of `paths` that is a file: `<hash>  <path>`, or `? <path>` without sha256sum. */
const fileHashes = (paths: string[]): Probe<Record<string, string>> => ({
  command: paths.length
    ? `for p in ${paths.map(shellQuote).join(" ")}; do [ -f "$p" ] || continue; sha256sum "$p" 2>/dev/null || printf '? %s\\n' "$p"; done`
    : "true",
  parse: ({ stdout }) =>
    Object.fromEntries(
      stdout.split("\n").flatMap((line) => {
        const match = /^([0-9a-f]{64}|\?)\s+(.+)$/.exec(line.trim());
        return match ? [[match[2], match[1]]] : [];
      })
    ),
});

/** Long enough to find a device and read every config it has. */
const timeoutMs = 20000;

/** Every device's changes, read from the devices now (read-only). */
export const readApplyDiff = async ({
  intentPath,
  platform,
}: {
  intentPath: string;
  platform: Platform;
}): Promise<DeviceDiff[]> => {
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const { ready } = provisionableDevices(oncConfig);
  return readEach<DeviceDiff>({
    intentPath,
    platform,
    devices: ready,
    facts: readFacts(platform, intentPath, ready.map((d) => d.hostname)),
    timeoutMs,
    read: async (found) => {
      const deviceConfig = ready.find((d) => d.hostname === found.hostname)!;
      const state = getOpenWrtState({ oncConfig, deviceConfig, deviceSchema: found.schema });
      const first = await runProbes(found.session, {
        config: uciConfigs,
        installed: installedPackages,
        managed: managedFiles(managedFilesManifest),
      });
      const paths = [...new Set([...(state.files ?? []).map((f) => f.path), ...first.managed])];
      const { hashes } = await runProbes(found.session, { hashes: fileHashes(paths) });
      return deviceDiff({
        hostname: found.hostname,
        state,
        now: { config: first.config.configs, installed: first.installed, managed: first.managed, hashes },
        sha256: platform.sha256,
      });
    },
    failed: (hostname, error) => ({ hostname, error }),
  });
};
