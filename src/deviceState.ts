// What a device holds, as an apply's review reads it (src/applyDiff.ts) and
// as the run reads it again before changing anything (src/apply/plan.ts):
// every config, the installed packages, the managed files' hashes. Its
// `stateHash` is what a reviewed plan carries to the run, so a device changed
// between the two is caught before anything is armed.
import { installedPackages, managedFiles, Probe, runProbes, uciConfigs } from "./deviceProbes";
import { managedFilesManifest } from "./getDeviceScript";
import { Session } from "./platform";
import { isSecretOption } from "./secretOptions";
import { shellQuote } from "./shell";
import { UciConfigs, UciSection } from "./engine/uci";

/** One `uci show` line's value; a secret's is compared, never shown or stamped. */
export type Line = { value: string; secret: boolean };

const show = (value: string | string[]) => (Array.isArray(value) ? value : [value]).map((v) => `'${v}'`).join(" ");

/** Each section with its key as `uci show` prints it: anonymous ones as `@type[i]`. */
export const keyed = (configs: UciConfigs) =>
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

/** What a device holds now, as read. */
export type DeviceNow = {
  config: UciConfigs;
  installed: string[];
  /** Files the last apply wrote, from its manifest. */
  managed: string[];
  /** sha256 of each file asked about that exists; "?" where it could not be hashed. */
  hashes: Record<string, string>;
};

/** sha256 of each of `paths` that is a file: `<hash>  <path>`, or `? <path>` without sha256sum. */
export const fileHashes = (paths: string[]): Probe<Record<string, string>> => ({
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

/** Read what a device holds, hashing the managed files and `paths` (the files an apply would write). Two round trips. */
export const readDeviceNow = async (session: Session, paths: string[]): Promise<DeviceNow> => {
  const first = await runProbes(session, { config: uciConfigs, installed: installedPackages, managed: managedFiles(managedFilesManifest) });
  const { hashes } = await runProbes(session, { hashes: fileHashes([...new Set([...paths, ...first.managed])]) });
  return { config: first.config.configs, installed: first.installed, managed: first.managed, hashes };
};

/**
 * What a device holds, as one hash: its config lines, its packages, its
 * managed files. Only files it manages count (the files an apply would write
 * depend on the settings, which may be saved between review and run), and
 * a secret's value is left out: the hash goes to the page, and one over
 * otherwise known lines would let a weak Wi-Fi key be guessed.
 */
export const stateHash = (now: DeviceNow, sha256: (text: string) => string) =>
  sha256(
    JSON.stringify({
      config: [...uciLines(now.config)].sort(([a], [b]) => a.localeCompare(b)).map(([key, line]) => [key, line.secret ? "" : line.value]),
      installed: [...now.installed].sort(),
      files: now.managed.map((path) => [path, now.hashes[path] ?? ""]).sort(([a], [b]) => a.localeCompare(b)),
    })
  );
