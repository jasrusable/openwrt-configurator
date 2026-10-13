// The committed fixtures, read the same way by every test.
import { readFileSync } from "fs";
import { join } from "path";
import { intentSchema } from "../../intent/schema";
import { planOfJson } from "../../loadConfig";
import { Plan } from "../../plan/types";
import { OpenWrtState } from "../../engine/openWrtState";
import { keepEntryOf } from "../../lowLevel/parse";
import { parseJson } from "../../utils";

export const repoRoot = join(__dirname, "..", "..", "..");

/** A JSON file of the repository, by its path from the root. */
export const readRepoJson = (...path: string[]) => JSON.parse(readFileSync(join(repoRoot, ...path), "utf8"));

const samplePath = join(repoRoot, "sampleConfigs", "intent.json");

/** The sample intent file as written. */
export const sampleIntentText = () => readFileSync(samplePath, "utf8");

/** The sample intent as written, before its defaults. */
export const sampleIntentJson = () => JSON.parse(sampleIntentText());

/** The sample intent, parsed: defaults filled in. */
export const sampleIntent = () => intentSchema.parse(sampleIntentJson());

/** A hand-written low-level config, checked and read as the CLI reads one (its failure thrown). */
export const planOf = (json: unknown): Plan => {
  const read = planOfJson(json);
  if (!read.ok) throw new Error(read.error.message);
  return read.value.plan;
};

/** A low-level fixture in src/tests/main (config.json, config2.json): as written, as a plan, and its enabled devices. */
export const fixtureConfig = (name: string) => {
  const json = parseJson(readFileSync(join(__dirname, "..", "main", name), "utf-8"));
  const plan = planOf(json);
  return { json, plan, deviceConfigs: plan.devices.filter((device) => device.enabled !== false) };
};

/** A device's state for a test: what it does not set, empty. */
export const stateOf = (partial: Partial<OpenWrtState> = {}): OpenWrtState => ({
  config: {},
  packages: { add: [], remove: [] },
  keep: [],
  services: [],
  files: [],
  ...partial,
});

/** Keep entries as the low-level format writes them: `config.*`, `config.type`, `?config.*`. */
export const keepsOf = (...texts: string[]) => texts.map(keepEntryOf);
