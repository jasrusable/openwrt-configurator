// What the VPN settings may be, given the rest: remote access makes its key
// as it is turned on, and a provider's tunnel never falls back.
import type { Choice } from "../feature";
import { isMain } from "../fragment";
import { newPrivateKey } from "../../wireguard";

export const vpnRules: Choice[] = [
  {
    // A provider's tunnel never falls back (vpn/compile.ts): the kill switch, always.
    path: "networks.*.access.fallback",
    values: [true],
    unavailable: (intent, [i]) => {
      const tunnel = intent.vpn.providers?.find((t) => t.id === intent.networks[Number(i)]?.access.via);
      return tunnel && `Never through a VPN provider: the plain line would leak what ${tunnel.name} hides.`;
    },
    refuses: false,
  },
  {
    // Turning it on makes the router's key, and lets clients reach the main network.
    path: "vpn.remote_access.enabled",
    values: [true],
    swap: (intent) =>
      intent.vpn.remote_access.private_key
        ? undefined
        : {
            note: "Makes the router's WireGuard key.",
            apply: (next) => {
              const remote = next.vpn.remote_access;
              return {
                ...next,
                vpn: {
                  ...next.vpn,
                  remote_access: {
                    ...remote,
                    enabled: true,
                    private_key: newPrivateKey(),
                    access: remote.access.networks.length
                      ? remote.access
                      : { ...remote.access, networks: next.networks.filter(isMain).map((n) => n.id) },
                  },
                },
              };
            },
          },
  },
];
