import { ONCConfig, oncConfigSchema } from "./oncConfigSchema";
import {
  findPlaintextSecrets,
  lookupKeychain,
  resolveSecrets,
  SecretLookup,
} from "./resolveSecrets";
import { platform } from "./platform";
import { parseJson, parseSchema } from "./utils";

export const loadOncConfig = async (
  configPath: string,
  options?: { lookup?: SecretLookup }
) => {
  const oncJson = parseJson(platform().readTextFile(configPath), configPath);
  for (const path of findPlaintextSecrets(oncJson)) {
    console.warn(
      `Warning: ${path} is stored in plaintext; use { "$secret": "name" } and \`openwrt-configurator secrets set <name>\`.`
    );
  }
  const { value, secrets } = await resolveSecrets(
    oncJson,
    options?.lookup ?? lookupKeychain
  );
  const oncConfig: ONCConfig = parseSchema(oncConfigSchema, value);
  return { oncConfig, secrets };
};
