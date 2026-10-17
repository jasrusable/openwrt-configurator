// What the DNS settings may be, given the rest.
import type { Choice } from "../feature";
import { where } from "../places";
import { dohProviders } from "./schema";

export const dnsRules: Choice[] = [
  {
    path: "networks.*.keep_dns",
    values: [true],
    unavailable: (intent, [n]) => {
      const network = intent.networks[Number(n)];
      const tunnel = intent.vpn.providers.find((t) => t.id === network?.access.via);
      if (network?.dhcp.dns_servers?.length) return "Its devices are given other DNS servers (DHCP): they would be sent back to the router.";
      if (tunnel) return `It goes out through ${tunnel.name}, whose DNS servers its devices use.`;
      return undefined;
    },
  },
  {
    path: "dns.upstream.fallback",
    values: ["cloudflare", "google", "quad9"],
    unavailable: (intent, _at, value) =>
      intent.dns.upstream.type === "encrypted" && intent.dns.upstream.provider === value
        ? "It is already the provider."
        : undefined,
  },
  {
    // The provider its own fallback: the fallback goes back to automatic (another provider).
    path: "dns.upstream.provider",
    values: dohProviders,
    swap: (intent, _at, value) =>
      intent.dns.upstream.type === "encrypted" && intent.dns.upstream.fallback === value
        ? {
            note: "Its fallback goes back to automatic.",
            apply: (next) =>
              next.dns.upstream.type === "encrypted"
                ? { ...next, dns: { ...next.dns, upstream: { ...next.dns.upstream, provider: value, fallback: undefined } } }
                : next,
          }
        : undefined,
  },
  {
    path: "dns.upstream.type",
    values: ["provider"],
    unavailable: (intent) => {
      const bare = intent.internet.lines.find((l) => l.type === "static" && !l.static.dns?.length);
      return (
        bare &&
        `${bare.name || "An internet line"} is set by hand, without DNS servers: add them under ${where("internet")} first.`
      );
    },
    // Reported at the line's DNS servers, where they are missing.
    refuses: false,
  },
];
