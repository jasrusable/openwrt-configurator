// Name resolution on the router: dnsmasq answers the home network, caches,
// and names local devices <name>.<domain>. With DNS over HTTPS it forwards
// everything to https-dns-proxy, which encrypts it to the chosen provider.
import { section } from "../../plan/types";
import { Feature, onRouter, serviceWhen } from "../fragment";

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

/** Where https-dns-proxy listens, for dnsmasq to forward to. */
const proxyPort = 5053;

export const dns: Feature = (intent) => {
  const domain = intent.dns.domain;
  const { upstream } = intent.dns;
  const provider = upstream.type === "encrypted" && providers[upstream.provider];
  // dnsmasq asks these instead of the provider's resolvers (resolv.conf).
  const servers =
    upstream.type === "encrypted"
      ? [`127.0.0.1#${proxyPort}`]
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
            ...(servers
              ? { noresolv: true, server: servers }
              : { resolvfile: "/tmp/resolv.conf.d/resolv.conf.auto" }),
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
            ]
          : [],
      },
    },
  };
};
