// Older intent files, upgraded one version at a time to the current one. A
// file is migrated when read, and written in the current format on its next
// save. A migration never drops a setting: it moves it to where it now lives.
import { intentVersion } from "./schema";

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
        // As format 2 had it, so the step to 3 can turn it into the firewall.
        access: { internet: true, other_networks: true, isolate_clients: false },
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

  // 2 -> 3: each network's access becomes the firewall's: a zone per
  // network (trusted ones accept input, the rest get router services),
  // forwardings to the internet and to the other zones as it allowed. The
  // stock rules stay on. Wi-Fi client isolation stays on the network.
  2: ({ networks, ...rest }) => ({
    ...rest,
    schema: 3,
    networks: networks.map(({ access, ...network }: Json) => ({
      ...network,
      isolate_clients: !!access?.isolate_clients,
    })),
    firewall: {
      zones: networks.map((n: Json) => ({
        id: n.id,
        networks: [n.id],
        input: n.access?.other_networks ? "accept" : "reject",
        forward: n.access?.other_networks ? "accept" : "reject",
        output: "accept",
        router_services: true,
      })),
      forwardings: networks.flatMap((n: Json) => [
        ...(n.access?.internet ? [{ from: n.id, to: "wan" }] : []),
        ...(n.access?.other_networks
          ? networks
              .filter((other: Json) => other.id !== n.id)
              .map((other: Json) => ({ from: n.id, to: other.id }))
          : []),
      ]),
      rules: [],
      port_forwards: [],
      builtin_rules_off: [],
    },
  }),

  // 3 -> 4: Wi-Fi client isolation moves from the network to each SSID on
  // it, where hostapd applies it. Radios get defaults (2.4 and 5 GHz on).
  3: ({ networks, wifi, ...rest }) => ({
    ...rest,
    schema: 4,
    networks: networks.map(({ isolate_clients, ...network }: Json) => network),
    wifi: (wifi ?? []).map((w: Json) => ({
      ...w,
      isolate_clients: !!networks.find((n: Json) => n.id === w.network)?.isolate_clients,
    })),
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
