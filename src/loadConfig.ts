import { ONCConfig, oncConfigSchema } from "./oncConfigSchema";
import {
  findPlaintextSecrets,
  defaultSecretSource,
  resolveSecrets,
  SecretLookup,
} from "./resolveSecrets";
import { Platform } from "./platform";
import { parseConfigJson } from "./parseJson";
import { parseSchema } from "./utils";
import { compileIntent, intentSchema, isIntent } from "./intent/compile";

export const loadOncConfig = async ({
  path: configPath,
  platform,
  lookup,
}: {
  path: string;
  platform: Platform;
  /** Overrides where `$secret` refs are looked up (tests inject one). */
  lookup?: SecretLookup;
}) => {
  const oncJson = parseConfigJson(
    platform.readTextFile(configPath),
    configPath
  );
  if (isIntent(oncJson)) {
    // An intent file keeps its passwords, so only its owner may read it.
    const mode = platform.fileMode(configPath);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      console.warn(
        `Warning: ${configPath} holds passwords but is readable by others; chmod 600 it.`
      );
    }
  } else {
    for (const path of findPlaintextSecrets(oncJson)) {
      console.warn(
        `Warning: ${path} is stored in plaintext; use { "$secret": "name" } and \`openwrt-configurator secrets set <name>\`.`
      );
    }
  }
  const source = lookup
    ? { lookup, describeMissing: undefined }
    : defaultSecretSource(platform);
  const { value, secrets } = await resolveSecrets(
    oncJson,
    source.lookup,
    source.describeMissing
  );
  // An intent file compiles to the same low-level config a hand-written one
  // is, so every command takes either.
  const lowLevel = isIntent(value)
    ? compileIntent(parseSchema(intentSchema, value))
    : value;
  const oncConfig: ONCConfig = parseSchema(oncConfigSchema, lowLevel);
  return { oncConfig, secrets };
};
