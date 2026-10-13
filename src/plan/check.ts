// A plan checked before anything acts on it, the compiler's and a
// hand-written one's alike (src/loadConfig.ts runs it once): names uci
// would refuse, section types a config does not have, the option values the
// rules list (src/plan/rules.ts), each placeholder where it means something
// (src/plan/positions.ts), and the packages, services, files and keeps.
// What a section needs once fitted to a device is checked per device
// (rules.ts' deviceConfigIssues, in the engine).
import { placeholderProblem } from "./positions";
import {
  apkPackagePattern,
  ConfigIssue,
  filePathProblem,
  fileModePattern,
  knownSectionType,
  optionNamePattern,
  packageNamePattern,
  sectionNamePattern,
  servicePattern,
  valueIssues,
  wifiPsk,
} from "./rules";
import { isPlaceholder, Options, Plan, Value } from "./types";

const nameIssue = (name: string, pattern: RegExp, what: string, path: (string | number)[]): ConfigIssue[] =>
  pattern.test(name) ? [] : [{ path, message: `${what} ${JSON.stringify(name)} must be letters, digits and _${pattern === packageNamePattern ? " or -" : ""}` }];

/** A value's placeholders where they fit, and its plain value by its option's rule. */
const optionIssues = (at: string, value: Value, path: (string | number)[]): ConfigIssue[] => {
  const items = Array.isArray(value) ? value : [value];
  const placed = items.flatMap((item) => {
    if (!isPlaceholder(item)) return [];
    const problem = placeholderProblem(item, at, !Array.isArray(value));
    const keys =
      item.kind === "stations"
        ? item.keys.flatMap((key) => {
            const psk = wifiPsk.safeParse(key);
            return psk.success ? [] : psk.error.issues.map((issue) => issue.message);
          })
        : [];
    return [...(problem ? [{ path, message: problem }] : []), ...keys.map((message) => ({ path, message }))];
  });
  // A list with placeholders in it is checked by them alone: what they stand for is the device's.
  return items.some(isPlaceholder) ? placed : valueIssues(at, value, path);
};

const optionsIssues = (config: string, type: string, options: Options, path: (string | number)[]) =>
  Object.entries(options).flatMap(([option, value]) => [
    ...nameIssue(option, optionNamePattern, "option", [...path, option]),
    ...optionIssues(`${config}.${type}.${option}`, value, [...path, option]),
  ]);

/** Everything wrong with a plan, or nothing. */
export const planIssues = (plan: Plan): ConfigIssue[] => [
  ...plan.packages.flatMap((p, i) =>
    [...(p.add ?? []), ...(p.remove ?? [])]
      .filter((name) => !apkPackagePattern.test(name))
      .map((name) => ({ path: ["packages", i], message: `${JSON.stringify(name)} is not an apk package name` }))
  ),
  ...plan.services.flatMap((s, i) => (servicePattern.test(s.name) ? [] : [{ path: ["services", i, "name"], message: "must be an init script name" }])),
  ...plan.files.flatMap((f, i) => [
    ...(filePathProblem(f.path) ? [{ path: ["files", i, "path"], message: filePathProblem(f.path)! }] : []),
    ...(f.mode !== undefined && !fileModePattern.test(f.mode) ? [{ path: ["files", i, "mode"], message: "must be an octal mode such as 0755" }] : []),
  ]),
  ...plan.keep.flatMap((k, i) =>
    k.entries.flatMap((entry) => [
      ...nameIssue(entry.config, packageNamePattern, "config", ["keep", i]),
      ...(entry.type !== undefined ? nameIssue(entry.type, packageNamePattern, "section type", ["keep", i]) : []),
    ])
  ),
  ...Object.entries(plan.config).flatMap(([config, types]) => [
    ...nameIssue(config, packageNamePattern, "config", ["config", config]),
    ...Object.entries(types).flatMap(([type, sections]) => [
      ...nameIssue(type, packageNamePattern, "section type", ["config", config, type]),
      ...(knownSectionType(config, type) ? [] : [{ path: ["config", config, type], message: "unknown section type" }]),
      ...sections.flatMap((s, i) => {
        const path = ["config", config, type, i];
        const names = [s.name, ...(s.overrides ?? []).map((o) => o.name)].filter((n): n is string => n !== undefined);
        return [
          ...names.flatMap((name) => nameIssue(name, sectionNamePattern, "section", [...path, ".name"])),
          ...optionsIssues(config, type, s.options, path),
          ...(s.overrides ?? []).flatMap((o, j) => optionsIssues(config, type, o.options, [...path, ".overrides", j])),
        ];
      }),
    ]),
  ]),
];
