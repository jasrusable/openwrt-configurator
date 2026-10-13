// What a checkout makes of a corpus of intents: for every intent, device and
// board, what the engine leaves the device (its state: config, packages,
// services, files, keeps) and the uci operations that config is written
// with, or the error it stops on. Not the device script around them: how a
// step is done on the device is the agent's (src/agent), tested on its own.
// Run inside the checkout being measured (cwd = its root), so its own code
// makes it; scripts/equivalence.ts runs it on two and compares. Only entry
// points that survive refactors are used: loading an intent file, the
// device's state and its uci operations.
//
// Usage: ts-node --transpile-only <this> <corpus.json> <boards.json> <out.jsonl>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = process.cwd();
/** The first of these modules the checkout has (files move between versions). */
const need = (...paths: string[]) => {
  for (const path of paths) {
    try {
      return require(join(root, path));
    } catch (e) {
      if ((e as { code?: string }).code !== "MODULE_NOT_FOUND" || !String((e as Error).message).includes(path)) throw e;
    }
  }
  throw new Error(`None of ${paths.join(", ")} in ${root}.`);
};

type AnyState = Record<string, unknown> & { config: Record<string, Record<string, unknown[]>> };

/** Field names as any version spelt them, in today's spelling. */
const camel: Record<string, string> = {
  run_after: "runAfter",
  run_after_reload: "runAfterReload",
  restart_after_rollback: "restartAfterRollback",
};
const camelCased = (value: unknown) =>
  value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, v]) => [camel[key] ?? key, v]))
    : value;
const keepText = (entry: unknown) =>
  typeof entry === "string"
    ? entry
    : (({ config, type, optional }: { config: string; type?: string; optional?: boolean }) => `${optional ? "?" : ""}${config}.${type ?? "*"}`)(
        entry as { config: string }
      );

/**
 * A state in one shape whatever version made it: packages as `{ add, remove }`,
 * keeps as their text, services and files in today's field names.
 */
const normalized = (state: AnyState) => {
  const { packagesToInstall, packagesToUninstall, configsToNotReset, packages, keep, services, files, config } = state as Record<string, unknown> &
    AnyState;
  return {
    config,
    packages: (packages as { add: string[]; remove: string[] }) ?? {
      add: ((packagesToInstall as { packageName: string }[]) ?? []).map((p) => p.packageName),
      remove: (packagesToUninstall as string[]) ?? [],
    },
    keep: ((keep ?? configsToNotReset ?? []) as unknown[]).map(keepText),
    services: ((services ?? []) as unknown[]).map(camelCased),
    files: ((files ?? []) as unknown[]).map(camelCased),
  };
};

/**
 * A state as its script would write it: its configs' empty section lists
 * left out (older engines kept a type with none, which writes nothing) and
 * each section's name first.
 */
const withoutEmptyTypes = (state: { config: Record<string, Record<string, unknown[]>> }) => ({
  ...state,
  config: Object.fromEntries(
    Object.entries(state.config)
      .map(
        ([config, types]) =>
          [
            config,
            Object.fromEntries(
              Object.entries(types)
                .filter(([, sections]) => sections.length)
                // Its name first: where it sits among the options is no difference.
                .map(([type, sections]) => [type, (sections as Record<string, unknown>[]).map(({ ".name": name, ...options }) => ({ ".name": name, ...options }))])
            ),
          ] as const
      )
      .filter(([, types]) => Object.keys(types).length)
  ),
});

const main = async () => {
  const [corpusPath, boardsPath, outPath] = process.argv.slice(2);
  const corpus: unknown[] = JSON.parse(readFileSync(corpusPath, "utf8"));
  const boards: { name: string; schema?: unknown; board?: unknown; system?: unknown }[] = JSON.parse(readFileSync(boardsPath, "utf8"));
  // Any API it has had: loadConfigOrThrow, loadConfig (a plan, or later a
  // Result of one) or, before the typed plan, loadOncConfig and its config.
  const loading = need("src/loadConfig");
  const loadAny = loading.loadConfigOrThrow ?? loading.loadConfig ?? loading.loadOncConfig;
  const load = async (options: unknown) => {
    const loaded = await loadAny(options);
    if (loaded && loaded.ok === false) throw new Error(loaded.error.message);
    return loaded && loaded.ok === true ? loaded.value : loaded;
  };
  const { nodePlatform } = need("src/platforms/node");
  const { getOpenWrtState } = need("src/engine/getOpenWrtState", "src/getOpenWrtState");
  const { getUciCommands } = need("src/engine/getUciCommands", "src/getUciCommands");
  const { deviceSchemaSchema } = need("src/deviceSchema");
  const { parseDeviceFacts } = need("src/facts/board");
  const schemas = boards.map((b) => ({
    name: b.name,
    schema: b.schema ? deviceSchemaSchema.parse(b.schema) : parseDeviceFacts({ board: b.board, system: b.system }),
  }));
  const dir = mkdtempSync(join(tmpdir(), "onc-equivalence-"));
  // The corpus is generated by the newer code, so its intents carry settings
  // an older schema refuses as unknown. One left at an off value (false, none,
  // empty) changes nothing, so it is dropped here and the load retried; one
  // that is set stays, and the difference it makes shows as one.
  const off = (value: unknown): boolean =>
    value === undefined ||
    value === null ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.values(value as object).every(off));
  const unknownKeys = (message: string) =>
    [...message.matchAll(/([\w.]+): Unrecognized key\(s\) in object: ((?:'[^']+'(?:, )?)+)/g)].flatMap(([, at, keys]) =>
      [...keys.matchAll(/'([^']+)'/g)].map(([, key]) => ({ at: at.split("."), key }))
    );
  const without = (value: unknown, at: string[], key: string): unknown => {
    if (!value || typeof value !== "object") return value;
    if (!at.length) {
      const { [key]: dropped, ...rest } = value as Record<string, unknown>;
      return off(dropped) ? rest : value;
    }
    const [head, ...tail] = at;
    return Array.isArray(value)
      ? value.map((item, i) => (String(i) === head ? without(item, tail, key) : item))
      : { ...(value as Record<string, unknown>), [head]: without((value as Record<string, unknown>)[head], tail, key) };
  };
  const loadKnown = async (intent: unknown, path: string, tries = 5): Promise<{ devices: { hostname: string }[] }> => {
    writeFileSync(path, JSON.stringify(intent), { mode: 0o600 });
    try {
      const loaded = await load({ path, platform: nodePlatform, lookup: async (name: string) => `secret-${name}` });
      return loaded.plan ?? loaded.oncConfig;
    } catch (e) {
      const unknown = unknownKeys((e as Error).message);
      const stripped = unknown.reduce((v, { at, key }) => without(v, at, key), intent);
      if (!tries || !unknown.length || JSON.stringify(stripped) === JSON.stringify(intent)) throw e;
      return loadKnown(stripped, path, tries - 1);
    }
  };
  const lines: string[] = [];
  const quiet = console.warn;
  console.warn = () => {};
  try {
    for (const [index, intent] of corpus.entries()) {
      const path = join(dir, `${index}.json`);
      let config: { devices: { hostname: string }[] };
      try {
        config = await loadKnown(intent, path);
      } catch (e) {
        lines.push(JSON.stringify({ key: `${index}`, out: `ERROR: ${(e as Error).message}` }));
        continue;
      }
      for (const deviceConfig of config.devices) {
        for (const { name, schema } of schemas) {
          let out: string;
          try {
            const state = getOpenWrtState({ plan: config, oncConfig: config, deviceConfig, deviceSchema: schema });
            out = JSON.stringify({ ...withoutEmptyTypes(normalized(state)), uci: getUciCommands({ openWrtConfig: state.config }) }, null, 1);
          } catch (e) {
            out = `ERROR: ${(e as Error).message}`;
          }
          lines.push(JSON.stringify({ key: `${index}/${deviceConfig.hostname}/${name}`, out }));
        }
      }
    }
  } finally {
    console.warn = quiet;
    rmSync(dir, { recursive: true, force: true });
  }
  writeFileSync(outPath, lines.join("\n") + "\n");
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
