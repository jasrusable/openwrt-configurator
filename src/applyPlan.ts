// The change plan an apply is reviewed by, made once on the server and shown
// by the UI (ui/src/provision/Review.tsx) and the CLI (applyPlanText.ts)
// alike: every change in the user's terms, why it is there (your edit, an
// app update, a fix, or a change on the device it replaces), what it does
// that people notice, and its uci lines; a verdict sentence over all of it;
// what must be acknowledged first; and each device's state hash, which the
// run checks before arming anything (src/apply/plan.ts). Pure.
import type { ChangeWhy } from "./applyChanges";
import type { DeviceRead, FileChange, UciChange } from "./applyDiff";
import { Disruption, disruptionRank, Effect, effectsOf, minutesOf, secondsOf, totalSeconds, worst } from "./applyImpact";
import { byConfigOrder } from "./plan/uciOrder";
import type { Change } from "./intent/diff";
import { where } from "./intent/places";
import type { DeviceFailure } from "./readEach";
import type { Result } from "./result";

/** Where a change comes from: `drift` is a change on the device that applying replaces; `unknown`, an update or drift, not known which. */
export type PlanSource = "first" | "edit" | "fix" | "update" | "drift" | "unknown";

/** A uci line as printed: + added, − removed, ~ changed or renamed. */
export type PlanLine = { sign: "+" | "−" | "~"; text: string };

/** One device's lines for an item: by config in the order devices get them, then renames, packages and files. */
export type DeviceLines = { device: string; groups: { title: string; lines: PlanLine[] }[] };

export type PlanItem = {
  id: string;
  source: PlanSource;
  title: string;
  /** What it is for, or why it is there. */
  why?: string;
  /** An edit's change in a few words: "Off → On". */
  change?: string;
  devices: string[];
  effect: { disruption: Disruption; notices: string[] };
  lines: DeviceLines[];
  /** A change on a device: the settings its lines come from (dotted paths), so their rows can say so. */
  settings?: string[];
};

/**
 * What must be acknowledged before applying: devices dropping off (a "reconnect"
 * effect; a brief one is only listed), changes on a device it replaces, or
 * flash its packages take.
 */
export type PlanNeed =
  | { kind: "disruption"; device: string; effects: string[] }
  | { kind: "drift"; device: string; count: number }
  | { kind: "flash"; device: string; needKb: number; freeKb: number };

export type ApplyPlan = {
  /** When the devices were read. */
  readAt: number;
  items: PlanItem[];
  /** Each device read: what applying is noticed as there, and about how long it takes. */
  devices: { device: string; effects: Effect[]; seconds: number }[];
  unread: { device: string; error: string }[];
  summary: {
    devices: number;
    seconds: number;
    minutes: number;
    disruption: Disruption;
    verdict: string;
    /** Why applying would be refused before it starts, if it would. */
    blocked?: string;
  };
  needs: PlanNeed[];
  /** Each read device's state hash (src/deviceState.ts), sent back to start the apply. */
  verify: Record<string, string>;
};

/** One change on one device. */
type Unit = {
  device: string;
  why: ChangeWhy;
  fix?: string;
  group: string;
  line: PlanLine;
  /** For effects: the uci key, package or file it is. */
  key?: string;
  package?: { name: string; added: boolean };
  file?: string;
  change?: UciChange;
};

const lineOf = (change: UciChange): PlanLine =>
  change.renamedFrom
    ? { sign: "~", text: `${change.renamedFrom} renamed ${change.key.slice(change.key.indexOf(".") + 1)}` }
    : change.before === undefined
      ? { sign: "+", text: `${change.key}=${change.after}` }
      : change.after === undefined
        ? { sign: "−", text: `${change.key}=${change.before}` }
        : { sign: "~", text: `${change.key}: ${change.before} → ${change.after}` };

const fileSign = (file: FileChange) => (file.change === "added" ? "+" : file.change === "removed" ? "−" : "~");

const unitsOf = (d: DeviceRead): Unit[] => [
  ...d.config.map((change): Unit => ({
    device: d.hostname,
    why: change.why,
    ...(change.fix ? { fix: change.fix } : {}),
    group: change.renamedFrom ? "renamed" : change.key.split(".")[0],
    line: lineOf(change),
    key: change.key,
    change,
  })),
  ...[...d.packages.added.map((name) => ({ name, added: true })), ...d.packages.removed.map((name) => ({ name, added: false }))].map(
    (p): Unit => ({
      device: d.hostname,
      why: d.packages.why[p.name] ?? "unknown",
      ...(d.packages.fixes?.[p.name] ? { fix: d.packages.fixes[p.name] } : {}),
      group: "packages",
      line: { sign: p.added ? "+" : "−", text: `package ${p.name}` },
      package: p,
    })
  ),
  ...d.files.map((file): Unit => ({
    device: d.hostname,
    why: file.why,
    ...(file.fix ? { fix: file.fix } : {}),
    group: "files",
    line: { sign: fileSign(file), text: `file ${file.path}` },
    file: file.path,
  })),
];

/** Items with the same key, in the order first met. */
export const groupBy = <T, K>(items: T[], key: (item: T) => K): [K, T[]][] => [
  ...items.reduce((groups, item) => groups.set(key(item), [...(groups.get(key(item)) ?? []), item]), new Map<K, T[]>()),
];

const tail = ["renamed", "packages", "files"];

const linesOf = (units: Unit[]): DeviceLines[] =>
  groupBy(units, (u) => u.device).map(([device, onDevice]) => ({
    device,
    groups: groupBy(onDevice, (u) => u.group)
      .sort(([a], [b]) => tail.indexOf(a) - tail.indexOf(b) || byConfigOrder(a, b))
      .map(([title, grouped]) => ({ title, lines: grouped.map((u) => u.line) })),
  }));

/** What a change does, in a few words: "Added: Guests", "Off → On", "Changed" (a secret). */
export const changeWords = (change: Change) =>
  change.kind === "added"
    ? `Added${change.after ? `: ${change.after}` : ""}`
    : change.kind === "removed"
      ? "Removed"
      : change.before === undefined
        ? "Changed"
        : `${change.before} → ${change.after}`;

/** Whether a line comes from an edit at `path` (a dotted intent path): its setting, or else its item, on either side of it. */
export const fromEdit = (change: UciChange, path: string) => {
  const near = (p?: string) => p !== undefined && (p === path || p.startsWith(`${path}.`) || path.startsWith(`${p}.`));
  return change.setting ? near(change.setting) : near(change.item);
};

/** An edit in the settings, as an item: what Undo and a run's result list, and the plan's edits before their lines. */
export const editItem = (change: Change, index: number): Omit<PlanItem, "effect" | "lines" | "devices"> => ({
  // A path can come twice (one item removed and another added where it was).
  id: `edit:${change.kind}:${change.path}:${index}`,
  source: "edit",
  title: change.label.join(" › "),
  ...(change.description ? { why: change.description } : {}),
  change: changeWords(change),
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const listed = (words: string[]) =>
  words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

const sourceOrder: PlanSource[] = ["first", "edit", "fix", "update", "drift", "unknown"];

/** Explanations of the sources that are not edits, as the review and the CLI say them. */
export const sourceWords: Record<Exclude<PlanSource, "edit">, string> = {
  first: "Nothing was applied from these settings yet, so each device is given its whole configuration.",
  fix: `A fix over stock OpenWrt, coming or going (${where("patches")}).`,
  update: "The same settings, written differently by this version of the app.",
  drift: "Changed on the device since the last apply, by hand or by another tool: applying puts your settings back.",
  unknown:
    "Not from your edits: either this version of the app writes it differently, or it was changed on the device. Which is not known: there is no record of what the last apply left there, or it is a password, which is never recorded.",
};

export const buildApplyPlan = ({
  reads,
  edits,
  readAt,
}: {
  reads: Result<DeviceRead, DeviceFailure>[];
  /** The settings' changes since the last apply (none on a first apply). */
  edits: Change[];
  readAt: number;
}): ApplyPlan => {
  const read = reads.flatMap((r) => (r.ok ? [r.value] : []));
  const facts = new Map(read.map((d) => [d.hostname, d.impact]));
  const units = read.flatMap(unitsOf);

  const effectOf = (of: Unit[]) => {
    const effects = groupBy(of, (u) => u.device).flatMap(([device, onDevice]) =>
      effectsOf({
        hostname: device,
        keys: onDevice.flatMap((u) => (u.key ? [u.key] : [])),
        packages: {
          added: onDevice.flatMap((u) => (u.package?.added ? [u.package.name] : [])),
          removed: onDevice.flatMap((u) => (u.package && !u.package.added ? [u.package.name] : [])),
        },
        files: onDevice.flatMap((u) => (u.file ? [u.file] : [])),
        facts: facts.get(device)!,
      })
    );
    return { disruption: worst(effects), notices: effects.map((e) => e.text) };
  };
  const item = (base: Omit<PlanItem, "effect" | "lines" | "devices">, of: Unit[]): PlanItem => ({
    ...base,
    devices: [...new Set(of.map((u) => u.device))],
    effect: effectOf(of),
    lines: linesOf(of),
  });
  const of = (why: ChangeWhy) => units.filter((u) => u.why === why);

  const edited = of("edit");
  const caused = edits.map((change) => edited.filter((u) => u.change && fromEdit(u.change, change.path)));
  const rest = edited.filter((u) => !caused.some((c) => c.includes(u)));
  const byDevice = (source: PlanSource, title: (device: string) => string, units: Unit[]) =>
    groupBy(units, (u) => u.device).map(([device, onDevice]) => {
      const settings = [...new Set(onDevice.flatMap((u) => u.change?.setting ?? u.change?.item ?? []))];
      return {
        ...item({ id: `${source}:${device}`, source, title: title(device), why: sourceWords[source as Exclude<PlanSource, "edit">] }, onDevice),
        ...(settings.length ? { settings } : {}),
      };
    });

  const items = [
    ...(of("first").length ? [item({ id: "first", source: "first", title: "Every setting", why: sourceWords.first }, of("first"))] : []),
    ...edits.map((change, i) => item(editItem(change, i), caused[i])),
    ...(rest.length ? [item({ id: "edit:rest", source: "edit", title: "Other lines your edits change" }, rest)] : []),
    ...groupBy(of("fix"), (u) => u.fix ?? "Fix").map(([fix, fixUnits]) => item({ id: `fix:${fix}`, source: "fix", title: fix, why: sourceWords.fix }, fixUnits)),
    ...groupBy(of("update"), (u) => u.change?.label ?? u.line.text).map(([label, updated]) =>
      item({ id: `update:${label}`, source: "update", title: label, why: updated.find((u) => u.change?.about)?.change?.about ?? sourceWords.update }, updated)
    ),
    ...byDevice("drift", (device) => `Changed on ${device}`, of("device")),
    ...byDevice("unknown", (device) => `App update or changed on ${device}`, of("unknown")),
  ]
    .map((it, index) => ({ it, index }))
    // The most noticed first; then by source, in the order above.
    .sort(
      (a, b) =>
        disruptionRank[b.it.effect.disruption] - disruptionRank[a.it.effect.disruption] ||
        sourceOrder.indexOf(a.it.source) - sourceOrder.indexOf(b.it.source) ||
        a.index - b.index
    )
    .map(({ it }) => it);

  const devices = read
    .filter((d) => units.some((u) => u.device === d.hostname))
    .map((d) => {
      const onDevice = units.filter((u) => u.device === d.hostname);
      const changed = {
        hostname: d.hostname,
        keys: onDevice.flatMap((u) => (u.key ? [u.key] : [])),
        packages: { added: d.packages.added, removed: d.packages.removed },
        files: d.files.map((f) => f.path),
        facts: d.impact,
      };
      return { device: d.hostname, effects: effectsOf(changed), seconds: secondsOf(changed) };
    });
  const unread = reads.flatMap((r) => (r.ok ? [] : [{ device: r.error.hostname, error: r.error.message }]));
  const needs: PlanNeed[] = [
    ...devices.flatMap(({ device, effects }): PlanNeed[] => {
      const dropping = effects.filter((e) => e.disruption === "reconnect").map((e) => e.text);
      return dropping.length ? [{ kind: "disruption", device, effects: dropping }] : [];
    }),
    ...groupBy(of("device"), (u) => u.device).map(([device, drifted]): PlanNeed => ({ kind: "drift", device, count: drifted.length })),
    ...read.flatMap((d): PlanNeed[] => (d.space ? [{ kind: "flash", device: d.hostname, ...d.space }] : [])),
  ];
  const tooBig = needs.flatMap((n) => (n.kind === "flash" && n.needKb > n.freeKb ? [n.device] : []));
  const seconds = devices.map((d) => d.seconds);
  const disruption = worst(devices.flatMap((d) => d.effects));
  const summary = {
    devices: devices.length,
    seconds: totalSeconds(seconds),
    minutes: minutesOf(seconds),
    disruption,
    verdict: verdictOf({ items, devices: devices.map((d) => d.device), disruption, minutes: minutesOf(seconds), needs, unread }),
    // Refused at the start of the run as it would be: a device not in the reviewed changes is never applied unreviewed.
    ...(tooBig.length
      ? { blocked: `${listed(tooBig)} ${tooBig.length === 1 ? "has" : "have"} too little flash for the packages this apply installs: it would be refused.` }
      : unread.length
        ? { blocked: `${listed(unread.map((u) => u.device))} could not be read, so what applying changes there was not reviewed: it would be refused. Read again once ${unread.length === 1 ? "it answers" : "they answer"}.` }
        : {}),
  };
  return {
    readAt,
    items,
    devices,
    unread,
    summary,
    needs,
    verify: Object.fromEntries(read.map((d) => [d.hostname, d.hash])),
  };
};

const disruptionWords: Record<Disruption, string> = {
  reconnect: "Devices may drop off for a few seconds and reconnect.",
  brief: "Some services restart briefly; nothing should drop off.",
  none: "Nothing is interrupted.",
};

/** The plan in one sentence or three: what changes where, what is noticed, how long, and what to know first. */
const verdictOf = ({
  items,
  devices,
  disruption,
  minutes,
  needs,
  unread,
}: {
  items: PlanItem[];
  devices: string[];
  disruption: Disruption;
  minutes: number;
  needs: PlanNeed[];
  unread: ApplyPlan["unread"];
}) => {
  const notRead = unread.length ? ` ${listed(unread.map((u) => u.device))} could not be read, so what changes there is not known.` : "";
  if (!items.length) return unread.length ? notRead.trim() : "Everything is up to date: applying would change nothing.";
  const drift = needs.reduce((n, need) => n + (need.kind === "drift" ? need.count : 0), 0);
  const lines = devices.length
    ? `${plural(items.length, "change")} on ${listed(devices)}. ${disruptionWords[disruption]} About ${minutes} min.`
    : `${plural(items.length, "change")} to your settings, none of which changes a device.`;
  return `${lines}${drift ? ` Replaces ${plural(drift, "change")} made on the devices since the last apply.` : ""}${notRead}`;
};

const mib = (kb: number) => `${(kb / 1024).toFixed(1)} MiB`;

/** What an acknowledgement says, as the review's checkbox and the CLI put it. */
export const needWords = (need: PlanNeed) =>
  need.kind === "disruption"
    ? need.effects.join(" ")
    : need.kind === "drift"
    ? `Applying replaces ${plural(need.count, "change")} made on ${need.device} since the last apply.`
    : need.needKb > need.freeKb
      ? `${need.device} has ${mib(need.freeKb)} of flash free, and its new packages take about ${mib(need.needKb)}: they do not fit.`
      : `The new packages take about ${mib(need.needKb)} of the ${mib(need.freeKb)} of flash ${need.device} has free.`;

/** A source as a short tag. */
export const sourceTags: Record<PlanSource, string> = {
  first: "Everything",
  edit: "Your edit",
  fix: "Fix",
  update: "App update",
  drift: "Changed on device",
  unknown: "Update or device",
};
