// What an apply changes on each device, as OpenWrt sees it: the device's
// config as it is now (read live, `uci export`) against what the apply leaves
// (the saved intent compiled and resolved with the engine's own code, over the
// wipe and its keep rules), compared as `uci show` lines; plus packages and
// managed files. Read only while the Apply page is open, held in memory,
// never stored. Secret options (Wi-Fi keys, passwords) are compared but their
// values never leave this module.
import { KeepEntry, PlanDevice } from "./plan/types";
import type { DeviceSchema } from "./deviceSchema";
import { compileIntent } from "./intent/compile";
import { patches } from "./intent/patches";
import { needed } from "./intent/patches/patch";
import type { Intent } from "./intent/schema";
import { getPackagesToRemove, packagesToAdd } from "./getDeviceScript";
import { isSecretOption } from "./secretOptions";
import { readFacts } from "./deviceFacts";
import { installedPackages, managedFiles, Probe, runProbes, uciConfigs } from "./deviceProbes";
import { managedFilesManifest } from "./getDeviceScript";
import { getOpenWrtState } from "./engine/getOpenWrtState";
import { OpenWrtState } from "./engine/openWrtState";
import { Platform } from "./platform";
import { provisionableDevices } from "./apply/provisionConfig";
import { DeviceFailure, readEach } from "./readEach";
import { ok, Result } from "./result";
import { Problem } from "./problem";
import { loadSettings } from "./settings";
import { shellQuote } from "./shell";
import { declaredConfigs, isKept, sameValue, UciConfigs, UciSection } from "./engine/uci";

export type UciChange = {
  /** As `uci show` prints it: network.lan, or network.lan.ipaddr. */
  key: string;
  before?: string;
  after?: string;
  /** The section `key` was called before: renamed, its options compared under the new name. */
  renamedFrom?: string;
  /** The fix (src/intent/patches) this line comes from, by its title: not the settings. */
  fix?: string;
};

export type FileChange = { path: string; change: "added" | "removed" | "changed"; fix?: string };

export type DeviceChanges = {
  hostname: string;
  config: UciChange[];
  /** `fixes`: the fix each package comes from, where one does. */
  packages: { added: string[]; removed: string[]; fixes?: Record<string, string> };
  files: FileChange[];
};

/** What a device's changes come from fixes rather than the settings: a line's key, a file's path, a package, to the fix's title. */
export type FixSources = { config: Record<string, string>; files: Record<string, string>; packages: Record<string, string> };

/**
 * Which of a device's lines, files and packages each needed fix makes: the
 * device's state compiled with that fix off differs there. Derived from the
 * effect, so it cannot drift from what the fix does.
 */
export const fixSources = ({
  intent,
  deviceConfig,
  deviceSchema,
  state,
}: {
  intent: Intent;
  deviceConfig: PlanDevice;
  deviceSchema: DeviceSchema;
  state: OpenWrtState;
}): FixSources => {
  const lines = uciLines(declaredConfigs(state.config));
  const off = intent.system.patches?.off ?? [];
  return patches.filter(needed(intent)).reduce<FixSources>(
    (sources, patch) => {
      const without = compileIntent({ ...intent, system: { ...intent.system, patches: { off: [...off, patch.id] } } });
      const other = getOpenWrtState({ plan: without, deviceConfig, deviceSchema });
      const otherLines = uciLines(declaredConfigs(other.config));
      const keys = [...new Set([...lines.keys(), ...otherLines.keys()])].filter((key) => lines.get(key)?.value !== otherLines.get(key)?.value);
      const files = state.files.filter((f) => other.files.find((o) => o.path === f.path)?.content !== f.content).map((f) => f.path);
      const packages = [...state.packages.add, ...state.packages.remove].filter(
        (p) => !other.packages.add.includes(p) && !other.packages.remove.includes(p)
      );
      const by = (items: string[]) => Object.fromEntries(items.map((item) => [item, patch.title]));
      return {
        config: { ...sources.config, ...by(keys) },
        files: { ...sources.files, ...by(files) },
        packages: { ...sources.packages, ...by(packages) },
      };
    },
    { config: {}, files: {}, packages: {} }
  );
};

/** As the page gets it: each device's changes, or why it was not reached (what it holds is then not known, nor the change). */
/** A device whose changes could not be read, as the page gets it. */
export type DeviceUnread = { hostname: string; error: string };
export type DeviceDiff = DeviceChanges | DeviceUnread;

/** Each device's read as the page gets it: its changes, or why it was not read. */
export const diffOf = (read: Result<DeviceChanges, DeviceFailure>): DeviceDiff =>
  read.ok ? read.value : { hostname: read.error.hostname, error: read.error.message };

/** What the device holds after the apply: kept sections as they are, declared ones merged in or added. */
export const configsAfter = ({
  current,
  declared,
  keep,
}: {
  current: UciConfigs;
  declared: UciConfigs;
  keep: KeepEntry[];
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
      lines.set(`${key}.${option}`, { value: show(value), secret: isSecretOption(option) })
    );
  });
  return lines;
};

const bothSame = (a?: string | string[], b?: string | string[]) => a !== undefined && b !== undefined && sameValue(a, b);

/** How alike two sections' options are: the share with equal values, of all either has. */
const likeness = (a: UciSection, b: UciSection) => {
  const options = [...new Set([...Object.keys(a.options), ...Object.keys(b.options)])];
  return options.length === 0 ? 1 : options.filter((o) => bothSame(a.options[o], b.options[o])).length / options.length;
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
  fixes = { config: {}, files: {}, packages: {} },
}: {
  hostname: string;
  state: OpenWrtState;
  now: DeviceNow;
  sha256: (text: string) => string;
  /** What comes from fixes (fixSources), to say so beside each change. */
  fixes?: FixSources;
}): DeviceChanges => {
  const after = configsAfter({
    current: now.config,
    declared: declaredConfigs(state.config),
    keep: state.keep,
  });
  // As the apply writes it: a final newline added where there is none.
  const written = (content: string) => sha256(content.endsWith("\n") ? content : `${content}\n`);
  const files = state.files;
  const pairs = renames(now.config, after);
  const withFix = <T extends object>(item: T, fix?: string): T => (fix ? { ...item, fix } : item);
  const added = packagesToAdd({ state, installedPackages: now.installed });
  const removed = getPackagesToRemove({ state, installedPackages: now.installed });
  const packageFixes = Object.fromEntries([...added, ...removed].flatMap((p) => (fixes.packages[p] ? [[p, fixes.packages[p]]] : [])));
  return {
    hostname,
    config: [
      ...pairs.map(({ from, to }): UciChange => ({ key: to, renamedFrom: from })),
      ...diffLines(renamed(uciLines(now.config), pairs), uciLines(after)).map((change) => withFix(change, fixes.config[change.key])),
    ].sort((a, b) => a.key.localeCompare(b.key) || (a.renamedFrom ? -1 : 1)),
    packages: { added, removed, ...(Object.keys(packageFixes).length ? { fixes: packageFixes } : {}) },
    files: [
      ...files.flatMap((f): FileChange[] =>
        !(f.path in now.hashes)
          ? [withFix({ path: f.path, change: "added" as const }, fixes.files[f.path])]
          : now.hashes[f.path] !== written(f.content)
          ? [withFix({ path: f.path, change: "changed" as const }, fixes.files[f.path])]
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
}): Promise<Result<Result<DeviceChanges, DeviceFailure>[], Problem>> => {
  const loaded = await loadSettings(intentPath, platform);
  if (!loaded.ok) return loaded;
  const { plan, intent } = loaded.value;
  const { ready } = provisionableDevices(plan);
  const reads = await readEach({
    intentPath,
    platform,
    devices: ready,
    facts: readFacts(platform, intentPath, ready.map((d) => d.hostname)),
    timeoutMs,
    read: async (found) => {
      const deviceConfig = ready.find((d) => d.hostname === found.hostname)!;
      const state = getOpenWrtState({ plan, deviceConfig, deviceSchema: found.schema });
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
        ...(intent ? { fixes: fixSources({ intent, deviceConfig, deviceSchema: found.schema, state }) } : {}),
      });
    },
  });
  return ok(reads);
};
