// Name resolution on the router: dnsmasq answers the home network, caches,
// and names local devices <name>.<domain>. With DNS over HTTPS it forwards
// everything to https-dns-proxy, which encrypts it to the chosen provider.
import { section } from "../../plan/types";
import { wanZone } from "../access";
import { Feature, onRouter, routerOnly, serviceWhen } from "../fragment";
import type { Intent } from "../schema";
import { DohProvider } from "./schema";

const providers = {
  cloudflare: {
    url: "https://cloudflare-dns.com/dns-query",
    bootstrap: "1.1.1.1,1.0.0.1,2606:4700:4700::1111,2606:4700:4700::1001",
  },
  google: {
    url: "https://dns.google/dns-query",
    bootstrap: "8.8.8.8,8.8.4.4,2001:4860:4860::8888,2001:4860:4860::8844",
  },
  quad9: {
    url: "https://dns.quad9.net/dns-query",
    bootstrap: "9.9.9.9,149.112.112.112,2620:fe::fe,2620:fe::9",
  },
};

/** Where https-dns-proxy listens, for dnsmasq to forward to: the provider's instance, then the fallback's. */
const proxyPort = 5053;
const fallbackPort = 5054;
/** The same, for Status to ask each in turn (src/status/device/internet.ts). */
export const dohPorts = { provider: proxyPort, fallback: fallbackPort } as const;

/**
 * The provider asked when the chosen one does not answer: the one set, or
 * by default another (Quad9, or Cloudflare when Quad9 is the provider);
 * undefined with "none".
 */
export const fallbackOf = (upstream: Extract<Intent["dns"]["upstream"], { type: "encrypted" }>): DohProvider | undefined =>
  upstream.fallback === "none"
    ? undefined
    : (upstream.fallback ?? (upstream.provider === "quad9" ? "cloudflare" : "quad9"));

/**
 * Names that tell a device's own encrypted DNS to stand aside on this
 * network, answered with nothing (dnsmasq's server=/name/ with no server,
 * NXDOMAIN): Firefox turns its DNS over HTTPS off for
 * use-application-dns.net (https://support.mozilla.org/kb/canary-domain-use-application-dnsnet),
 * and Apple devices turn iCloud Private Relay off for mask.icloud.com and
 * mask-h2.icloud.com (https://developer.apple.com/support/prepare-your-network-for-icloud-private-relay).
 * One dnsmasq answers every network, so they apply to all as soon as one keeps its devices.
 */
export const dnsCanaries = ["use-application-dns.net", "mask.icloud.com", "mask-h2.icloud.com"];

export const providerLabels: Record<DohProvider, string> = { cloudflare: "Cloudflare", google: "Google", quad9: "Quad9" };

export const dns: Feature = (intent) => {
  const domain = intent.dns.domain;
  const { upstream } = intent.dns;
  const provider = upstream.type === "encrypted" && providers[upstream.provider];
  const fallback = upstream.type === "encrypted" ? fallbackOf(upstream) : undefined;
  // Networks whose devices are kept on the router's DNS (networks.*.keep_dns;
  // the rules refuse it where devices are meant to use other servers).
  const kept = intent.networks.filter((n) => n.keep_dns);
  // dnsmasq asks these instead of the provider's resolvers (resolv.conf).
  const servers =
    upstream.type === "encrypted"
      ? [`127.0.0.1#${proxyPort}`, ...(fallback ? [`127.0.0.1#${fallbackPort}`] : [])]
      : upstream.type === "custom"
        ? upstream.servers
        : undefined;
  return {
    // Installed whether used or not: a setting changes config, not packages.
    packages: [{ when: onRouter, add: ["https-dns-proxy", "luci-app-https-dns-proxy"] }],
    services: [
      { when: onRouter, name: "dnsmasq", running: true },
      // Unconfigured (no encryption), it runs nothing.
      serviceWhen(onRouter, "https-dns-proxy", upstream.type === "encrypted"),
    ],
    config: {
      dhcp: {
        // OpenWrt 25.12's own dnsmasq section (one instance, answering every
        // network it is attached to: localservice), with only what settings
        // decide changed; checked against a stock image's /etc/config/dhcp.
        dnsmasq: [
          section({ when: onRouter }, {
            domainneeded: true,
            boguspriv: true,
            filterwin2k: false,
            localise_queries: true,
            // Answers from outside may not point inside (DNS rebinding);
            // the router itself (127.0.0.0/8) stays allowed. Off is written
            // out: dnsmasq's init script defaults it to on (verified on 25.12.5).
            ...(intent.dns.rebind_protection ? { rebind_protection: true, rebind_localhost: true } : { rebind_protection: false }),
            local: `/${domain}/`,
            domain,
            expandhosts: true,
            nonegcache: false,
            cachesize: 1000,
            authoritative: true,
            readethers: true,
            // In RAM, as stock: a lease file on flash is written on every lease.
            leasefile: "/tmp/dhcp.leases",
            ...(servers ? { noresolv: true } : { resolvfile: "/tmp/resolv.conf.d/resolv.conf.auto" }),
            ...(servers || kept.length
              ? { server: [...(kept.length ? dnsCanaries.map((name) => `/${name}/`) : []), ...(servers ?? [])] }
              : {}),
            // The provider's proxy first, always; the fallback's only when it
            // does not answer, so the fallback provider sees no lookups while
            // the chosen one works. dnsmasq's strict-order tries servers in
            // their order (its man page, --strict-order); verified on 25.12.5
            // with two local upstreams: all to the first, failing over to the
            // second while the first is down, and back. Without it dnsmasq may
            // pick either. One proxy is one point of failure: an
            // https-dns-proxy crash took all DNS with it in
            // https://forum.openwrt.org/t/https-dns-proxy-crash-after-upgrade/250250
            // (a second instance does not help when the binary itself fails).
            ...(fallback ? { strictorder: true } : {}),
            nonwildcard: true,
            localservice: true,
            // DNS flag day 2020: replies small enough never to be fragmented.
            ednspacket_max: 1232,
            filter_aaaa: false,
            filter_a: false,
          }),
        ],
        // Your own names: name.<local domain> answers with the address.
        domain: intent.dns.hosts.map((r) => section({ when: onRouter }, { name: r.name, ip: r.address })),
      },
      // Keeping a network's devices on the router's DNS: plain DNS sent
      // anywhere is answered by the router (a redirect without an address
      // goes to the router itself; family any makes it IPv4 and IPv6 alike,
      // which fw4 otherwise limits to IPv4: verified on 25.12.5, a client
      // asking 8.8.8.8 got the router's answer), and DNS over TLS to the
      // internet is refused, so a device set to it falls back to plain DNS.
      // DNS over HTTPS cannot be told from other HTTPS: the canaries above
      // ask browsers to stand aside instead. After the firewall's own rules
      // (its order: 50), so a rule of the user's still comes first.
      firewall: {
        redirect: routerOnly(
          kept.map((n) =>
            section(
              { name: `keep_dns_${n.id}` },
              { name: `Keep-${n.id}-DNS`, target: "DNAT", src: n.id, src_dport: "53", proto: ["tcp", "udp"], family: "any" }
            )
          )
        ),
        rule: routerOnly(
          kept.map((n) =>
            section(
              { name: `keep_dns_${n.id}_dot` },
              { name: `Keep-${n.id}-DNS-over-TLS`, src: n.id, dest: wanZone, dest_port: "853", proto: ["tcp", "udp"], target: "REJECT" }
            )
          )
        ),
      },
      "https-dns-proxy": {
        main: [
          // Declared on or off: it has no "enabled", and with this section
          // missing it defaults to rewriting every dnsmasq instance and
          // capturing clients' DNS. dnsmasq is configured above, by us.
          section({ name: "config", when: onRouter }, { dnsmasq_config_update: "-", force_dns: false }),
        ],
        // Off: no instance, so the proxy runs nothing.
        "https-dns-proxy": provider
          ? [
              section(
                { when: onRouter },
                { resolver_url: provider.url, bootstrap_dns: provider.bootstrap, listen_port: String(proxyPort) }
              ),
              ...(fallback
                ? [
                    section(
                      { when: onRouter },
                      { resolver_url: providers[fallback].url, bootstrap_dns: providers[fallback].bootstrap, listen_port: String(fallbackPort) }
                    ),
                  ]
                : []),
            ]
          : [],
      },
    },
  };
};
