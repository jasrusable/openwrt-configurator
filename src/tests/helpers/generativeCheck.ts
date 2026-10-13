// What must hold of any valid intent, checked for one generated from a seed
// (intentGenerator.ts): it compiles, deterministically, to a plan its own
// check accepts and that reads back as itself from its low-level JSON; it fits every captured board it can be; and its declared config is
// consistent and verifies after the stage step's batch. generative.test.ts
// runs it over many seeds.
import { isDeepStrictEqual } from "util";
import { stageRecords } from "../../getDeviceScript";
import { getOpenWrtState } from "../../engine/getOpenWrtState";
import { DeviceSchema } from "../../deviceSchema";
import { compileIntent } from "../../intent/compile";
import { Intent } from "../../intent/schema";
import { planOfJson } from "../../loadConfig";
import { printPlan } from "../../lowLevel/print";
import { planIssues } from "../../plan/check";
import { declaredConfigs, UciConfigs, UciSection, verifyConfigs } from "../../engine/uci";
import { capturedBoards } from "./capturedBoards";
import { applyRecords } from "./fakeDevice";
import { generateIntent } from "./intentGenerator";

const boards = capturedBoards();

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/).filter(Boolean) : []);
const sectionsOf = (configs: UciConfigs, config: string, type?: string) =>
  (configs[config] ?? []).filter((s) => type === undefined || s.type === type);

/** What must hold of one device's declared config, in words; empty when it all does. */
export const configProblems = (configs: UciConfigs): string[] => {
  const interfaces = new Set(sectionsOf(configs, "network", "interface").map((s) => s.name));
  const named = (config: string) =>
    sectionsOf(configs, config)
      .map((s) => s.name)
      .filter((name): name is string => name !== undefined);
  const duplicates = Object.keys(configs).flatMap((config) =>
    named(config)
      .filter((name, i, names) => names.indexOf(name) !== i)
      .map((name) => `two sections named ${config}.${name}`)
  );
  const dangling = (config: string, type: string, option: string) =>
    sectionsOf(configs, config, type).flatMap((s: UciSection) =>
      listOf(s.options[option])
        .filter((ref) => !interfaces.has(ref))
        .map((ref) => `${config}.${s.name ?? type} ${option} names ${ref}, no interface`)
    );
  // A port untagged in two VLANs of one bridge (DSA) or switch (swconfig) would carry two networks at once.
  const untagged = (type: string, owner: string, ports: (s: UciSection) => string[]) => {
    const seen = new Map<string, string[]>();
    sectionsOf(configs, "network", type).forEach((s) =>
      ports(s).forEach((port) => {
        const key = `${s.options[owner]}/${port}`;
        seen.set(key, [...(seen.get(key) ?? []), String(s.options.vlan)]);
      })
    );
    return [...seen].filter(([, vlans]) => vlans.length > 1).map(([key, vlans]) => `${key} untagged in VLANs ${vlans.join(", ")}`);
  };
  return [
    ...duplicates,
    ...dangling("wireless", "wifi-iface", "network"),
    ...dangling("dhcp", "dhcp", "interface"),
    ...dangling("firewall", "zone", "network"),
    ...untagged("bridge-vlan", "device", (s) => listOf(s.options.ports).filter((p) => !p.includes(":t"))),
    ...untagged("switch_vlan", "device", (s) => listOf(s.options.ports).filter((p) => !p.endsWith("t"))),
  ];
};

/** The device as a fresh one holding each declared config empty, after the stage step's batch. */
const staged = (state: ReturnType<typeof getOpenWrtState>) => {
  const declared = declaredConfigs(state.config);
  const current: UciConfigs = Object.fromEntries(Object.keys(declared).map((config) => [config, []]));
  const actual: UciConfigs = structuredClone(current);
  applyRecords(actual, stageRecords({ state, current }));
  return verifyConfigs({ actual, declared, keep: state.keep });
};

/**
 * Whether a board can be this device. A router needs the ports its lines use:
 * unset, the one the board marks WAN; named, one it has, and not that WAN
 * port while another line takes it by default (only facts know which it is:
 * the engine refuses two lines on one port, and the UI never offers it). A
 * board that fails is a choice made against another board: not this one's to fit.
 */
const fits = (intent: Intent, role: string, schema: DeviceSchema) => {
  if (role !== "router") return true;
  const ports = schema.ports ?? [];
  const wan = ports.find((p) => p.default_role === "wan")?.name;
  const where = (l: Intent["internet"]["lines"][number]) => `${l.port ?? wan}.${l.vlan ?? ""}`;
  const lines = intent.internet.lines;
  return (
    lines.every((l) => (l.port === undefined ? wan !== undefined : ports.some((p) => p.name === l.port))) &&
    new Set(lines.map(where)).size === lines.length
  );
};

export const check = (seed: number): string[] => {
  const intent = generateIntent(seed);
  const problems: string[] = [];
  const compiled = compileIntent(intent);
  if (JSON.stringify(compileIntent(intent)) !== JSON.stringify(compiled)) problems.push("compiling twice differs");
  const issues = planIssues(compiled);
  if (issues.length) return [...problems, `the plan check refuses it: ${issues[0].path.join(".")}: ${issues[0].message}`];
  // A plan printed as a hand-written config reads back, checked as one is, as the same plan.
  const read = planOfJson(printPlan(compiled));
  if (!read.ok) return [...problems, `its low-level JSON is refused: ${read.error.message.slice(0, 300)}`];
  if (!isDeepStrictEqual(read.value.plan, compiled)) problems.push("its low-level JSON does not read back as the same plan");
  for (const deviceConfig of compiled.devices) {
    const role = String(deviceConfig.tags?.role);
    for (const { name, schema } of boards) {
      if (!fits(intent, role, schema)) continue;
      const at = `${deviceConfig.hostname} on ${name}`;
      try {
        const state = getOpenWrtState({ plan: compiled, deviceConfig, deviceSchema: schema });
        problems.push(...configProblems(declaredConfigs(state.config)).map((p) => `${at}: ${p}`));
        problems.push(...staged(state).map((p) => `${at}: verify: ${p}`));
      } catch (e) {
        problems.push(`${at}: ${(e as Error).message}`);
      }
    }
  }
  return problems;
};

