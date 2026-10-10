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
  for (const path of findPlaintextSecrets(oncJson)) {
    console.warn(
      `Warning: ${path} is stored in plaintext; use { "$secret": "name" } and \`openwrt-configurator secrets set <name>\`.`
    );
  }
  const source = lookup
    ? { lookup, describeMissing: undefined }
    : defaultSecretSource(platform);
  const { value, secrets } = await resolveSecrets(
    oncJson,
    source.lookup,
    source.describeMissing
  );
  const oncConfig: ONCConfig = parseSchema(oncConfigSchema, value);
  return { oncConfig, secrets };
};
