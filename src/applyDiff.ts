// What an apply changes on each device, as OpenWrt sees it: the last-applied
// and the saved intents compiled and resolved against the device's facts
// with the engine's own code (getOpenWrtState), then compared as `uci show`
// lines. Secrets (Wi-Fi keys, passwords) are compared but never shown.
// Offline: it reads no device, only the facts last read from one.
import { DeviceFacts } from "./deviceFacts";
import { getOpenWrtState } from "./getOpenWrtState";
import { ONCConfig } from "./oncConfigSchema";

export type UciChange = {
  /** As `uci show` prints it: network.lan, or network.lan.ipaddr. */
  key: string;
  before?: string;
  after?: string;
};

export type DeviceDiff =
  | {
      hostname: string;
      config: UciChange[];
      packages: { added: string[]; removed: string[] };
      files: { path: string; change: "added" | "removed" | "changed" }[];
    }
  /** Never read from: its ports and radios are not known, so neither is its UCI. */
  | { hostname: string; unknown: true };

/** Options whose values are never shown: Wi-Fi keys and passwords. */
const isSecret = (option: string) => /^(key|password|sae_password|auth_secret|acct_secret)$/.test(option);

/** A value as uci shows it: '1' for true, each list item quoted. */
const show = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(show).join(" ")
    : `'${typeof value === "boolean" ? (value ? "1" : "0") : String(value)}'`;

type Line = { value: string; secret: boolean };

/** A device's resolved config as `uci show` lines, by key. */
export const uciLines = (config: Record<string, Record<string, Record<string, unknown>[]>>) => {
  const lines = new Map<string, Line>();
  Object.entries(config).forEach(([pkg, types]) =>
    Object.entries(types).forEach(([type, sections]) =>
      sections.forEach((section) => {
        const name = `${pkg}.${section[".name"]}`;
        lines.set(name, { value: type, secret: false });
        Object.entries(section)
          .filter(([option, value]) => !option.startsWith(".") && value !== undefined && value !== "")
          .filter(([, value]) => !(Array.isArray(value) && value.length === 0))
          .forEach(([option, value]) =>
            lines.set(`${name}.${option}`, { value: show(value), secret: isSecret(option) })
          );
      })
    )
  );
  return lines;
};

const hidden = "(hidden)";

/** The lines that differ, in the order a reader expects: sorted by key. */
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

/**
 * Each device's changes from `before` (the last applied; undefined when
 * nothing was) to `after` (the saved). A device without facts is `unknown`.
 */
export const applyDiff = ({
  before,
  after,
  facts,
}: {
  before?: ONCConfig;
  after: ONCConfig;
  facts: Record<string, DeviceFacts | undefined>;
}): DeviceDiff[] =>
  after.devices.map((deviceConfig) => {
    const known = facts[deviceConfig.hostname];
    if (!known) return { hostname: deviceConfig.hostname, unknown: true as const };
    const deviceSchema = known.schema;
    const stateOf = (oncConfig?: ONCConfig) => {
      const device = oncConfig?.devices.find((d) => d.hostname === deviceConfig.hostname);
      return oncConfig && device ? getOpenWrtState({ oncConfig, deviceConfig: device, deviceSchema }) : undefined;
    };
    const was = stateOf(before);
    const will = stateOf(after)!;
    const names = (state?: ReturnType<typeof stateOf>) =>
      (state?.packagesToInstall ?? []).map((p) => p.packageName);
    const filesOf = (state?: ReturnType<typeof stateOf>) =>
      new Map((state?.files ?? []).map((f) => [f.path, `${f.mode ?? ""}\n${f.content}`]));
    const oldFiles = filesOf(was);
    const newFiles = filesOf(will);
    return {
      hostname: deviceConfig.hostname,
      config: diffLines(uciLines((was?.config ?? {}) as never), uciLines(will.config as never)),
      packages: {
        added: names(will).filter((p) => !names(was).includes(p)),
        removed: names(was).filter((p) => !names(will).includes(p)),
      },
      files: [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort().flatMap(
        (path): { path: string; change: "added" | "removed" | "changed" }[] =>
        !oldFiles.has(path)
          ? [{ path, change: "added" }]
          : !newFiles.has(path)
          ? [{ path, change: "removed" }]
          : oldFiles.get(path) !== newFiles.get(path)
          ? [{ path, change: "changed" }]
          : []
      ),
    };
  });
