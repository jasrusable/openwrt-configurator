// Name resolution on the router: dnsmasq answers the home network, caches,
// and names local devices <name>.<domain>. With DNS over HTTPS it forwards
// everything to https-dns-proxy, which encrypts it to the chosen provider.
import { Feature, onRouter } from "../fragment";

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
  const domain = intent.dns.local_domain;
  const provider = intent.dns.over_https && providers[intent.dns.over_https];
  return {
    package_profiles: provider
      ? [
          {
            ".if": onRouter,
            packages: ["https-dns-proxy", "luci-app-https-dns-proxy"],
          },
        ]
      : [],
    config: {
      dhcp: {
        dnsmasq: [
          {
            ".if": onRouter,
            domainneeded: true,
            localise_queries: true,
            local: `/${domain}/`,
            domain,
            expandhosts: true,
            authoritative: true,
            readethers: true,
            leasefile: "/etc/dhcp.leases",
            localservice: true,
            cachesize: 5000,
            dnsforwardmax: 1000,
            interface: intent.networks.map((n) => n.id),
            quietdhcp: true,
            ...(provider
              ? { noresolv: true, server: [`127.0.0.1#${proxyPort}`] }
              : {}),
          },
        ],
      },
      ...(provider
        ? {
            "https-dns-proxy": {
              main: [
                {
                  ".if": onRouter,
                  ".name": "config",
                  // Leave dnsmasq alone: it is configured above.
                  dnsmasq_config_update: "-",
                  force_dns: false,
                },
              ],
              "https-dns-proxy": [
                {
                  ".if": onRouter,
                  resolver_url: provider.url,
                  bootstrap_dns: provider.bootstrap,
                  listen_port: String(proxyPort),
                },
              ],
            },
          }
        : {}),
    },
  };
};
