// A patch: a fix or tuning layered over what OpenWrt ships, kept apart from
// the features so it can be added for a model, a target, a role or a release
// as problems are found, and dropped when OpenWrt fixes them upstream.
//
// Declarative, and pure in the intent. It says why it exists and where that
// was seen (references, added, verified, dropWhen), what it targets, and what
// it changes: new files, sections, packages, keeps and services as any
// feature does, plus three things only patches do:
// - amend: options added to sections other features made (an SSID, a radio),
//   as overrides that hold only on the target, so no section is duplicated
//   and the feature's own options are left as they were elsewhere. Scoped
//   in the user's terms: `of` names the intent items whose sections it
//   changes ("wifi.networks.*"), and `where` sees each item, typed;
// - restarts: a service restarted after something its own reload triggers do
//   not cover (a firewall reload, a package swap).
// It applies where both hold: the device (its target) and the settings
// (`applies`, and each amend's `of`/`where`). Which settings it changes is
// derived, never written by hand: an amended option's origin (the setting the
// feature set it from, plan/types.ts) is where the patch shows, with its
// `note`, as a mark on that setting (marks.ts); `affects` names the settings
// of what has no option to trace (a file, a restart). Everything it emits
// applies only where it targets (`targetCondition`).
import { Feature, merge } from "../fragment";
import type { Fragment, Options, Plan, Section } from "../../plan/types";
import { keepText } from "../../plan/types";
import { KeepEntry, PlanFile, Sections, Service } from "../../plan/types";
import { when, When } from "../../plan/when";
import { matchPattern, PatternValue, SettingPath, valueAt } from "../paths";
import { Intent } from "../schema";
import type { DeviceSchema } from "../../deviceSchema";

type Role = Intent["hardware"][number]["role"];

/** Where a patch applies, each part narrowing it; empty is every device. */
export type Target = {
  /** Board ids, as /etc/board.json has them (device.model_id). */
  models?: string[];
  /** OpenWrt targets/subtargets (device.target: mediatek/filogic): devices sharing a SoC family's drivers. */
  targets?: string[];
  roles?: Role[];
  /** OpenWrt releases: from one (inclusive), before another (exclusive). */
  releases?: { from?: string; before?: string };
  /** Anything else the device must have, as a condition over its facts (a radio), with words for listings. */
  requires?: { when: When; note: string };
};

/**
 * What a patch rests on, for whoever reads it later: the bug, the fix that
 * lets it go, a measurement, the user's own report. `report`: something seen
 * on a real device (say which, and when, in `note`).
 */
export type Reference = {
  kind: "issue" | "pr" | "commit" | "forum" | "docs" | "report";
  url: string;
  note?: string;
};

/** Options added to every section of a config and type another feature made (or those `of`/`where` pick). */
export type Amend = {
  config: string;
  type: string;
  /** The intent items whose sections it changes ("wifi.networks.*"); unset, every section of the type. */
  of?: SettingPath;
  /** Which of them; every one when unset. Pure: it sees the item (with `of`) and the section as compiled. */
  where?: (from: { item: unknown; section: Section }) => boolean;
  options: Options;
};

/**
 * An amend scoped to intent items, `where` typed by them: the patch speaks in
 * the user's terms (an SSID's security), not the compiler's (an option's
 * value), so it outlives the compiler renaming things.
 */
export const amendOf = <P extends SettingPath>(
  of: P,
  amend: Omit<Amend, "of" | "where"> & { where?: (from: { item: PatternValue<Intent, P>; section: Section }) => boolean }
): Amend => {
  const { where, ...rest } = amend;
  // Each section's item is the one at its origin's path, which `of` matches.
  return { ...rest, of, ...(where ? { where: where as unknown as Amend["where"] } : {}) };
};

/** A service restarted after what its own reload triggers miss. */
export type Restart =
  /** After every firewall start or reload (fw4 rebuilds its tables, and what another daemon put there goes). */
  | { service: string; after: "firewall-reload" }
  /** When the run installs or removes one of these packages (exact, or a prefix ending in `*`): a swap whose postinst does not restart what runs it. */
  | { service: string; after: "package-change"; packages: string[] };

export type Effects = {
  files?: Omit<PlanFile, "when">[];
  config?: Sections;
  packages?: { add?: string[]; remove?: string[] };
  /** What the wipe leaves alone on the target. */
  keeps?: KeepEntry[];
  services?: Omit<Service, "when">[];
  amend?: Amend[];
  restarts?: Restart[];
};

export type Patch = {
  /** Short and stable, like "r6s-packet-steering". */
  id: string;
  /** What it does, in one line, for people ("Fast roaming held off on 25.12"). */
  title: string;
  /** Its absence breaks something silently, so it cannot be turned off (system.patches.off). */
  required?: boolean;
  /** What it changes about the settings it marks (marks.ts), for their ⓘ and its chip. */
  note?: string;
  /**
   * The settings it changes that no amended option traces to (a file, a
   * restart, an option no setting sets): typed, so a renamed setting fails
   * to compile. Empty: it changes nothing a setting says.
   */
  affects?: SettingPath[];
  /** The problem it fixes, and how it was seen (a measurement, a report). */
  why: string;
  /** A fix waits on OpenWrt (an issue or PR to watch); a tuning is ours to keep. */
  kind: "fix" | "tuning";
  /** At least one, with a URL; a fix names the issue or PR that lets it go. */
  references: Reference[];
  /** When it was added, YYYY-MM-DD. */
  added: string;
  /** Where and how it was checked ("Docker 25.12.5", "the user's NWA50AX Pro, 2026-10-12"). */
  verified: string;
  /** When it goes, in words; with `target.releases.before` once the fixed release is known. */
  dropWhen: string;
  target: Target;
  /** Whether the intent needs it at all (a service that is on); unset, always. */
  applies?: (intent: Intent) => boolean;
  /** What it changes, without conditions: the target is added to each. */
  apply: (intent: Intent) => Effects;
};

/**
 * A part of a target: a condition with its words. `role`: decided by the
 * intent, so known before any facts; `release`: the one it names; `fixed`:
 * a device past it runs a release with the fix.
 */
type TargetPart = { when: When; words: string; role?: boolean; release?: string; fixed?: boolean };

/** The target's parts: the one source of the engine's condition, the listing's words and each device's state (status.ts). */
export const targetParts = ({ models, targets, roles, releases, requires }: Target): TargetPart[] => [
  ...(requires ? [{ when: requires.when, words: `where it ${requires.note}` }] : []),
  ...(models ? [{ when: when.oneOf("device.model_id", models), words: `on ${models.join(" or ")}` }] : []),
  ...(targets ? [{ when: when.oneOf("device.target", targets), words: `on ${targets.join(" or ")}` }] : []),
  ...(roles ? [{ when: when.oneOf("device.tag.role", roles), words: `on ${roles.map((r) => `${r}s`).join(" and ")}`, role: true }] : []),
  ...(releases?.from
    ? [{ when: when.order("device.version", ">=", releases.from), words: `from OpenWrt ${releases.from}`, release: releases.from }]
    : []),
  ...(releases?.before
    ? [{ when: when.order("device.version", "<", releases.before), words: `before OpenWrt ${releases.before}`, release: releases.before, fixed: true }]
    : []),
];

/** The target as a condition: each part narrowing it, every device when it has none. */
export const targetCondition = (target: Target): When => when.all(...targetParts(target).map((part) => part.when));

/** What the device facts (model, target, release) still decide, in words; roles are known from the intent. */
export const describeTarget = (target: Target) =>
  targetParts(target)
    .filter((part) => !part.role)
    .map((part) => part.words)
    .join(", ");

/** Each device's facts, as stored (deviceFacts.ts): only its schema is read. */
export type Facts = Record<string, { schema: DeviceSchema } | undefined>;

/** Whether the intent needs it: not turned off, and its settings in use. */
export const needed = (intent: Intent) => (patch: Patch) =>
  !(intent.system.patches?.off ?? []).includes(patch.id) && (patch.applies?.(intent) ?? true);

/** A UCI-safe name for what a patch makes on its own behalf. */
const ownName = (patch: Patch, suffix: string) => `onc_${patch.id}_${suffix}`.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * A firewall include (fw4 runs it after every start and reload, an
 * interface coming up included; verified on 25.12.5) restarting the service
 * if it runs, in the background and once at a time, as fw4 waits on includes.
 */
const afterFirewallReload = (patch: Patch, service: string) => {
  const path = `/usr/libexec/onc/after-firewall-${patch.id}-${service}`;
  return {
    file: {
      path,
      mode: "0755",
      content: `#!/bin/sh
# ${patch.id}: fw4 rebuilt its tables, dropping what ${service} had put there; restart it.
[ -x /etc/init.d/${service} ] && /etc/init.d/${service} running || exit 0
(
	mkdir /tmp/onc-${patch.id}.lock 2>/dev/null || exit 0
	trap 'rmdir /tmp/onc-${patch.id}.lock' EXIT
	sleep 2
	/etc/init.d/${service} restart
) >/dev/null 2>&1 &
`,
    },
    include: { name: ownName(patch, service), options: { type: "script", path, fw4_compatible: true } },
  };
};

/** A patch's changes as a fragment, each made conditional on its target. */
const fragmentOf = (patch: Patch, intent: Intent): Fragment => {
  const target = targetCondition(patch.target);
  const effects = patch.apply(intent);
  const { files = [], config = {}, packages, keeps = [], services = [], restarts = [] } = effects;
  // The target narrows what each declares for itself, never replaces it.
  const onTarget = <T extends object>(item: T & { when?: When }): T & { when: When } => ({
    ...item,
    when: when.all(target, item.when ?? when.always),
  });
  const firewall = restarts.flatMap((r) => (r.after === "firewall-reload" ? [afterFirewallReload(patch, r.service)] : []));
  const swapRestarts = restarts.flatMap((r): Omit<Service, "when">[] =>
    r.after === "package-change" ? [{ name: r.service, restartOnPackages: r.packages }] : []
  );
  const withIncludes: Sections = firewall.length
    ? { ...config, firewall: { ...config.firewall, include: [...(config.firewall?.include ?? []), ...firewall.map((f) => f.include)] } }
    : config;
  return {
    files: [...files, ...firewall.map((f) => f.file)].map(onTarget),
    packages: packages?.add?.length || packages?.remove?.length ? [{ when: target, ...packages }] : [],
    keep: keeps.length ? [{ when: target, entries: keeps }] : [],
    services: [...services, ...swapRestarts].map(onTarget),
    config: Object.fromEntries(
      Object.entries(withIncludes).map(([key, types]) => [
        key,
        Object.fromEntries(Object.entries(types).map(([type, sections]) => [type, sections.map(onTarget)])),
      ])
    ),
  };
};

/** Every patch the intent needs, as one fragment (merged in the patches' order). */
export const applyPatches =
  (patches: Patch[]): Feature =>
  (intent) =>
    merge(patches.filter(needed(intent)).map((patch) => fragmentOf(patch, intent)));

/** Whether an amend changes this section: of its config and type, its item's (`of`), and `where` agrees. */
const amends = (amend: Amend, intent: Intent, config: string, type: string, section: Section) => {
  if (amend.config !== config || amend.type !== type) return false;
  const item = section.origin?.item;
  if (amend.of && !(item && matchPattern(amend.of, item.split(".")))) return false;
  return amend.where?.({ item: item ? valueAt(intent, item) : undefined, section }) ?? true;
};

/** Every needed patch's amends, each with its patch and where it holds. */
const neededAmends = (patches: Patch[], intent: Intent) =>
  patches.filter(needed(intent)).flatMap((patch) =>
    (patch.apply(intent).amend ?? []).map((amend) => ({ amend, patch, when: targetCondition(patch.target) }))
  );

/** Each section of a plan with what is done to it, by config and type. */
const mapSections = (plan: Pick<Plan, "config">, f: (config: string, type: string, section: Section) => Section): Plan["config"] =>
  Object.fromEntries(
    Object.entries(plan.config).map(([config, types]) => [
      config,
      Object.fromEntries(Object.entries(types).map(([type, sections]) => [type, sections.map((s) => f(config, type, s))])),
    ])
  );

/**
 * The plan with every needed patch's amends: an override on each matching
 * section, holding where the patch's target does. Applied after every
 * feature's sections are merged, so a patch can amend any of them.
 */
export const amendPlan =
  (patches: Patch[]) =>
  <P extends Pick<Plan, "config">>(intent: Intent, plan: P): P => {
    const all = neededAmends(patches, intent);
    if (!all.length) return plan;
    return {
      ...plan,
      config: mapSections(plan, (config, type, section) =>
        all
          .filter(({ amend }) => amends(amend, intent, config, type, section))
          .reduce<Section>((s, { amend, when }) => ({ ...s, overrides: [...(s.overrides ?? []), { when, options: amend.options }] }), section)
      ),
    };
  };

/**
 * Where each needed patch's amends land in the settings, per patch:
 * - overrides: each setting an amended option was set from (by item: one
 *   SSID's), where the amend changes its value, with the condition of each
 *   section it does so on (which devices that setting reaches there);
 * - untraced: options it amends that no setting set (its `affects` covers them);
 * - amendsAnything: whether any section matched at all.
 */
export const amendedSettings = (patches: Patch[], intent: Intent, plan: Pick<Plan, "config">) =>
  patches.filter(needed(intent)).map((patch) => {
    const touched = (patch.apply(intent).amend ?? []).flatMap((amend) =>
      Object.entries(plan.config).flatMap(([config, types]) =>
        Object.entries(types).flatMap(([type, sections]) =>
          sections
            .filter((section) => amends(amend, intent, config, type, section))
            .flatMap((section) =>
              Object.entries(amend.options).map(([option, value]) => ({
                option,
                setting: section.origin?.settings?.[option],
                section,
                // What the setting compiled to, overridden only where the amend says otherwise.
                differs: JSON.stringify(section.options[option]) !== JSON.stringify(value),
              }))
            )
        )
      )
    );
    const overridden = touched.filter((t) => t.setting && t.differs);
    return {
      patch,
      overrides: [...new Set(overridden.map((t) => t.setting!))].map((setting) => ({
        setting,
        sections: overridden.filter((t) => t.setting === setting).map((t) => t.section.when ?? when.always),
      })),
      untraced: [...new Set(touched.filter((t) => !t.setting).map((t) => t.option))],
      amendsAnything: touched.length > 0,
    };
  });

/** A list in words: "a, b and c". */
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const shown = (value: Options[string]) => (typeof value === "object" ? JSON.stringify(value) : String(value));

/**
 * What a patch does, in words, from what it declares (so the words cannot
 * drift from the effect): its amends, files, packages, keeps, services,
 * restarts and sections.
 */
export const effectsOf = (patch: Patch, intent: Intent): string[] => {
  const { files = [], config = {}, packages, keeps = [], services = [], amend = [], restarts = [] } = patch.apply(intent);
  return [
    ...amend.map(
      (a) =>
        `Sets ${listed(Object.entries(a.options).map(([k, v]) => `${k} ${shown(v)}`))} on ${a.config} ${a.type} sections${
          a.of ? ` (of ${a.of.replace(/\.\*/g, "")}${a.where ? ", where it applies" : ""})` : a.where ? " (where it applies)" : ""
        }`
    ),
    ...files.map((f) => `Adds ${f.path}${f.runAfter ? ", run when written" : ""}${f.runAfterReload ? ", run after the reload" : ""}`),
    ...(packages?.add?.length ? [`Installs ${listed(packages.add)}`] : []),
    ...(packages?.remove?.length ? [`Removes ${listed(packages.remove)}`] : []),
    ...keeps.map((k) => `Keeps the device's ${keepText(k)} through the wipe`),
    ...services.map((sv) => `${sv.enabled === false ? "Stops and disables" : "Enables and starts"} ${sv.name}`),
    ...restarts.map((r) =>
      r.after === "firewall-reload"
        ? `Restarts ${r.service} after every firewall reload`
        : `Restarts ${r.service} when a run installs or removes ${listed(r.packages)}`
    ),
    ...Object.entries(config).flatMap(([key, types]) =>
      Object.entries(types).map(([type, sections]) => `Adds ${sections.length} ${key} ${type} section${sections.length === 1 ? "" : "s"}`)
    ),
  ];
};

/**
 * The patches each device gets, as far as the intent decides: its role and
 * the intent's settings. `only` is what the device itself still decides
 * (model, target, release), empty when nothing does.
 */
export const patchesFor = (patches: Patch[], intent: Intent) =>
  intent.hardware.map((device) => ({
    device: device.name,
    patches: patches
      .filter(needed(intent))
      .filter((p) => !p.target.roles || p.target.roles.includes(device.role))
      .map(({ id, title, why, references, dropWhen, target }) => ({ id, title, why, references, dropWhen, only: describeTarget(target) })),
  }));
