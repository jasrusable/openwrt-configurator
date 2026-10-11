// Older intent files, upgraded one version at a time to the current one. A
// file is migrated when read, and written in the current format on its next
// save. A migration never drops a setting: it moves it to where it now lives.
// Until the first release the format stays at 1 and files are edited by hand.
import { intentVersion } from "./schema";

type Json = Record<string, any>;

const migrations: Record<number, (old: Json) => Json> = {};

/** The intent in the current format, whatever version it was written in. */
export const migrateIntent = (json: unknown): unknown => {
  let intent = json as Json;
  if (!intent || typeof intent !== "object" || typeof intent.schema !== "number") {
    return json; // Not an intent file; the schema will say what is wrong.
  }
  if (intent.schema > intentVersion) {
    throw new Error(
      `This intent file is version ${intent.schema}, newer than this tool ` +
        `understands (${intentVersion}). Upgrade openwrt-configurator.`
    );
  }
  while (intent.schema < intentVersion) {
    const migrate = migrations[intent.schema];
    if (!migrate) throw new Error(`No migration from intent version ${intent.schema}.`);
    intent = migrate(intent);
  }
  return intent;
};
