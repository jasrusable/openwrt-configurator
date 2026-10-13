// What an apply changes on each device, as OpenWrt sees it: the device's
// config as it is now (read live, `uci export`) against what the apply leaves
// (the saved intent compiled and resolved with the engine's own code, over the
// wipe and its keep rules), compared as `uci show` lines; plus packages and
// managed files. Read only while the Apply sheet is open, held in memory,
// never stored; made into the change plan by src/applyPlan.ts. Secret
// options (Wi-Fi keys, passwords) are compared but their values never leave
// this module.
import { KeepEntry, Plan, PlanDevice } from "./plan/types";
import type { DeviceSchema } from "./deviceSchema";
import { compileIntent } from "./intent/compile";
import { patches } from "./intent/patches";
import { needed } from "./intent/patches/patch";
import type { Intent } from "./intent/schema";
import { getPackagesToRemove, packagesToAdd } from "./getDeviceScript";
import { readFacts } from "./deviceFacts";
import { PackageSpace, packageSpace, runProbe } from "./deviceProbes";
import { DeviceNow, keyed, Line, readDeviceNow, stateHash, uciLines } from "./deviceState";
import { getOpenWrtState } from "./engine/getOpenWrtState";
import { OpenWrtState } from "./engine/openWrtState";
import { Platform } from "./platform";
import { provisionableDevices } from "./apply/provisionConfig";
import { DeviceFailure, readEach } from "./readEach";
import { ok, Result } from "./result";
import { Problem } from "./problem";
import { intentFileOrNothing, loadSettings } from "./settings";
import { ApplyPlan, buildApplyPlan } from "./applyPlan";
import { diffIntent } from "./intent/diff";
import { declaredConfigs, isKept, sameValue, UciConfigs, UciSection } from "./engine/uci";
import {
  AppliedStamp,
  appliedKey,
  ChangeWhy,
  Described,
  describeLine,
  fileWhy,
  lineWhy,
  Origins,
  originsOf,
  packageWhy,
  renameWhy,
  stampOf,
  writtenHash,
} from "./applyChanges";
import { ImpactFacts, impactFacts } from "./applyImpact";
import { read, stateLayout, tryWrite } from "./store";
import { loadConfig } from "./loadConfig";

export type UciChange = {
  /** As `uci show` prints it: network.lan, or network.lan.ipaddr. */
  key: string;
  before?: string;
  after?: string;
  /** The section `key` was called before: renamed, its options compared under the new name. */
  renamedFrom?: string;
  /** The fix (src/intent/patches) this line comes from, by its title: not the settings. */
  fix?: string;
  /** Why it changes (src/applyChanges.ts). */
  why: ChangeWhy;
} & Described;

export type FileChange = { path: string; change: "added" | "removed" | "changed"; fix?: string; why: ChangeWhy };

export type DeviceChanges = {
  hostname: string;
  config: UciChange[];
  /** `fixes`: the fix each package comes from, where one does; `why`: why each comes or goes. */
  packages: { added: string[]; removed: string[]; fixes?: Record<string, string>; why: Record<string, ChangeWhy> };
  files: FileChange[];
  /** What of its state decides what applying there is noticed as (src/applyImpact.ts). */
  impact: ImpactFacts;
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

/** A device read for review: its changes, the hash of what it held (src/deviceState.ts), and the flash its new packages need. */
export type DeviceRead = DeviceChanges & { hash: string; space?: PackageSpace };

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
export const diffLines = (before: Map<string, Line>, after: Map<string, Line>): { key: string; before?: string; after?: string }[] =>
  [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((key) => {
      const a = before.get(key);
      const b = after.get(key);
      if (a?.value === b?.value) return [];
      const shown = (line?: Line) => (line ? (line.secret ? hidden : line.value) : undefined);
      return [{ key, before: shown(a), after: shown(b) }];
    });

/** The lines a state leaves on a device that holds `current`, over the wipe and its keeps. */
export const linesAfter = (state: OpenWrtState, current: UciConfigs) =>
  uciLines(configsAfter({ current, declared: declaredConfigs(state.config), keep: state.keep }));

/** One device's changes, from what it holds now to what the apply leaves, each with why it changes. Pure. */
export const deviceDiff = ({
  hostname,
  role,
  state,
  now,
  sha256,
  fixes = { config: {}, files: {}, packages: {} },
  last,
  stamp,
  origins,
  intent,
}: {
  hostname: string;
  role?: string;
  state: OpenWrtState;
  now: DeviceNow;
  sha256: (text: string) => string;
  /** What comes from fixes (fixSources), to say so beside each change. */
  fixes?: FixSources;
  /** The settings last applied, compiled today for this device; absent when none were (applyChanges.ts). */
  last?: { state: OpenWrtState };
  /** What the last apply left there, as hashes. */
  stamp?: AppliedStamp;
  /** Where each section came from in the settings, to name a line in people's terms. */
  origins?: Origins;
  intent?: unknown;
}): DeviceChanges => {
  const after = configsAfter({ current: now.config, declared: declaredConfigs(state.config), keep: state.keep });
  const context = { last: last && { state: last.state, lines: linesAfter(last.state, now.config) }, stamp, sha256 };
  const files = state.files;
  const pairs = renames(now.config, after);
  const withFix = <T extends object>(item: T, fix?: string): T => (fix ? { ...item, fix } : item);
  const added = packagesToAdd({ state, installedPackages: now.installed });
  const removed = getPackagesToRemove({ state, installedPackages: now.installed });
  const packageFixes = Object.fromEntries([...added, ...removed].flatMap((p) => (fixes.packages[p] ? [[p, fixes.packages[p]]] : [])));
  const nowLines = renamed(uciLines(now.config), pairs);
  const afterLines = uciLines(after);
  const config = [
    ...pairs.map(({ from, to }): UciChange => ({ key: to, renamedFrom: from, why: renameWhy(from, to, context), ...describeLine(to, origins, intent) })),
    ...diffLines(nowLines, afterLines).map(
      (change): UciChange => ({
        ...withFix(change, fixes.config[change.key]),
        why: lineWhy(change.key, nowLines.get(change.key), afterLines.get(change.key), fixes.config[change.key], context),
        ...describeLine(change.key, origins, intent),
      })
    ),
  ].sort((a, b) => a.key.localeCompare(b.key) || (a.renamedFrom ? -1 : 1));
  const fileChanges = [
    ...files.flatMap((f): FileChange[] => {
      const nowHash = now.hashes[f.path];
      const change = nowHash === undefined ? ("added" as const) : nowHash !== writtenHash(sha256, f.content) ? ("changed" as const) : undefined;
      return change ? [withFix({ path: f.path, change, why: fileWhy(f.path, f.content, nowHash, fixes.files[f.path], context) }, fixes.files[f.path])] : [];
    }),
    ...now.managed
      .filter((path) => path in now.hashes && !files.some((f) => f.path === path))
      .map((path): FileChange => ({ path, change: "removed", why: fileWhy(path, undefined, now.hashes[path], undefined, context) })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const packageWhys = Object.fromEntries([
    ...added.map((p) => [p, packageWhy(p, true, fixes.packages[p], context)] as const),
    ...removed.map((p) => [p, packageWhy(p, false, fixes.packages[p], context)] as const),
  ]);
  return {
    hostname,
    config,
    packages: { added, removed, ...(Object.keys(packageFixes).length ? { fixes: packageFixes } : {}), why: packageWhys },
    files: fileChanges,
    impact: impactFacts(state, role),
  };
};


/**
 * What an apply left on each device, kept as hashes beside the intent
 * (applyChanges.ts): the next apply's changes are then told apart as an
 * update or a change on the device. From the declared state, which the
 * apply verified the device holds.
 */
export const stampApplied = ({
  plan,
  schemas,
  intentPath,
  files,
}: {
  plan: Plan;
  schemas: Map<string, DeviceSchema>;
  intentPath: string;
  files: Pick<Platform, "readTextFile" | "writeFileAtomic" | "mkdirp" | "removeFile" | "sha256">;
}) =>
  provisionableDevices(plan).ready.forEach((deviceConfig) => {
    const deviceSchema = schemas.get(deviceConfig.hostname);
    if (!deviceSchema) return;
    const state = getOpenWrtState({ plan, deviceConfig, deviceSchema });
    tryWrite(files, appliedKey(intentPath, deviceConfig.hostname), stampOf(uciLines(declaredConfigs(state.config)), state, files.sha256));
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
}): Promise<Result<Result<DeviceRead, DeviceFailure>[], Problem>> => {
  const loaded = await loadSettings(intentPath, platform);
  if (!loaded.ok) return loaded;
  const { plan, intent } = loaded.value;
  const { ready } = provisionableDevices(plan);
  // The settings last applied, compiled by this version of the app: what is
  // not an edit then is an update, or a change on the device.
  const lastLoaded = await loadConfig({ path: stateLayout(intentPath).lastApplied, platform });
  const lastPlan = lastLoaded.ok ? lastLoaded.value.plan : undefined;
  const reads = await readEach({
    intentPath,
    platform,
    devices: ready,
    facts: readFacts(platform, intentPath, ready.map((d) => d.hostname)),
    timeoutMs,
    read: async (found) => {
      const deviceConfig = ready.find((d) => d.hostname === found.hostname)!;
      const state = getOpenWrtState({ plan, deviceConfig, deviceSchema: found.schema });
      const now = await readDeviceNow(found.session, state.files.map((f) => f.path));
      const lastDevice = lastPlan && provisionableDevices(lastPlan).ready.find((d) => d.hostname === found.hostname);
      const stamp = read(platform, appliedKey(intentPath, found.hostname));
      const role = deviceConfig.tags?.role;
      const changes = deviceDiff({
        hostname: found.hostname,
        ...(typeof role === "string" ? { role } : {}),
        state,
        now,
        sha256: platform.sha256,
        ...(intent ? { fixes: fixSources({ intent, deviceConfig, deviceSchema: found.schema, state }) } : {}),
        ...(lastPlan && lastDevice ? { last: { state: getOpenWrtState({ plan: lastPlan, deviceConfig: lastDevice, deviceSchema: found.schema }) } } : {}),
        ...(stamp ? { stamp } : {}),
        origins: originsOf(plan, deviceConfig, found.schema),
        intent,
      });
      // As the run measures it (src/apply/plan.ts), only when something is installed: apk asks its mirror first.
      const space = changes.packages.added.length
        ? await runProbe(found.session, packageSpace({ add: changes.packages.added, remove: changes.packages.removed }))
        : undefined;
      return { ...changes, hash: stateHash(now, platform.sha256), ...(space ? { space } : {}) };
    },
  });
  return ok(reads);
};

/** The change plan an apply is reviewed by (src/applyPlan.ts), read from the devices now (read-only). */
export const readApplyPlan = async ({
  intentPath,
  platform,
  now,
}: {
  intentPath: string;
  platform: Platform;
  now: () => number;
}): Promise<Result<ApplyPlan, Problem>> => {
  const reads = await readApplyDiff({ intentPath, platform });
  if (!reads.ok) return reads;
  const live = intentFileOrNothing(platform, stateLayout(intentPath).lastApplied);
  // Never applied from here: everything is new, so there are no edits, only "every setting".
  const edits = live ? diffIntent(live, intentFileOrNothing(platform, intentPath)) : [];
  return ok(buildApplyPlan({ reads: reads.value, edits, readAt: now() }));
};
