// The committed fixtures, read the same way by every test.
import { readFileSync } from "fs";
import { join } from "path";
import { intentSchema } from "../../intent/schema";
import { ONCConfig, oncConfigSchema } from "../../oncConfigSchema";
import { parseJson, parseSchema } from "../../utils";

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

/** A low-level fixture in src/tests/main (config.json, config2.json): as written, parsed, and its enabled devices. */
export const fixtureConfig = (name: string) => {
  const json = parseJson(readFileSync(join(__dirname, "..", "main", name), "utf-8"));
  const oncConfig: ONCConfig = parseSchema(oncConfigSchema, json);
  return { json, oncConfig, deviceConfigs: oncConfig.devices.filter((device) => device.enabled !== false) };
};
