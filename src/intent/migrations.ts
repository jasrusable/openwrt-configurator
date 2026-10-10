// Older intent files, upgraded one version at a time to the current one. A
// file is migrated when read, and written in the current format on its next
// save. A migration never drops a setting: it moves it to where it now lives.
import { intentVersion, purposeAccess } from "./schema";

type Json = Record<string, any>;

const migrations: Record<number, (old: Json) => Json> = {
  // 1 -> 2: one `network` becomes `networks[]`, the main one; Wi-Fi names
  // the network it joins; the local domain moves to DNS.
  1: ({ network, wifi, dns, ...rest }) => ({
    ...rest,
    schema: 2,
    networks: [
      {
        id: "lan",
        name: "Home",
        purpose: "home",
        access: purposeAccess.home,
        subnet: network?.subnet,
        ...(network?.dhcp ? { dhcp: network.dhcp } : {}),
        ...(network?.ipv6 !== undefined ? { ipv6: network.ipv6 } : {}),
      },
    ],
    wifi: (wifi ?? []).map((w: Json) => ({ ...w, network: "lan" })),
    dns: {
      ...(dns ?? {}),
      ...(network?.domain ? { local_domain: network.domain } : {}),
    },
  }),
};

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
