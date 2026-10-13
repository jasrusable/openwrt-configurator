// DNS rebinding: a page on any site whose name is made to point at the
// router is same-origin with it, and could use the API with what the router
// answers. Browsers send the name they used as Host, so only names the
// router goes by are answered. The Mac's server checks Host itself
// (platforms/node.ts); under uhttpd the CGI does, with this.

const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The host a Host header names, without its port, lower case: `[v6]`, an address or a name. */
const hostOf = (header: string) => {
  const host = header.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.replace(/:\d+$/, "").replace(/\.$/, "");
};

/**
 * The names the router goes by, from the intent as written (read loosely:
 * a file that does not validate still has them): its own, with the local
 * domain, its dynamic DNS name, and OpenWrt's defaults.
 */
export const routerNames = (intent: unknown): string[] => {
  const i = (intent ?? {}) as {
    hardware?: { name?: unknown; role?: unknown }[];
    dns?: { domain?: unknown };
    internet?: { dynamic_dns?: { hostname?: unknown } };
  };
  const domain = typeof i.dns?.domain === "string" ? i.dns.domain : "lan";
  const router = (Array.isArray(i.hardware) ? i.hardware : []).find((h) => h?.role === "router")?.name;
  const ddns = i.internet?.dynamic_dns?.hostname;
  return [
    "localhost",
    "openwrt",
    `openwrt.${domain}`,
    ...(typeof router === "string" ? [router, `${router}.${domain}`] : []),
    ...(typeof ddns === "string" ? [ddns] : []),
  ].map((name) => name.toLowerCase());
};

/** Whether a request's Host is one the router answers to: an address, or one of its names. */
export const hostAllowed = (header: string | undefined, names: string[]) => {
  if (!header) return false;
  const host = hostOf(header);
  return host.startsWith("[") || ipv4.test(host) || names.includes(host);
};
