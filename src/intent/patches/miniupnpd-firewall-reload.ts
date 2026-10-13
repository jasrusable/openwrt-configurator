import { Patch } from "./patch";

export const miniupnpdFirewallReload: Patch = {
  id: "miniupnpd-firewall-reload",
  title: "UPnP mappings restored after firewall reloads",
  note: "miniupnpd is restarted after each firewall reload, which would otherwise drop every port mapping",
  affects: ["internet.upnp"],
  why:
    "miniupnpd keeps its port mappings in chains inside fw4's table, and every firewall start or " +
    "reload rebuilds that table without them: an apply touching the firewall, or an interface " +
    "coming up (20-firewall reloads), silently drops every UPnP and NAT-PMP mapping, and miniupnpd " +
    "never adds them back. A restart reads them back from its lease file. Verified on 25.12.5 " +
    "(miniupnpd 2.3.9): 2 rules after a mapping, 0 after `fw4 reload`, 2 again after a restart.",
  kind: "fix",
  references: [
    {
      kind: "pr",
      url: "https://github.com/openwrt/packages/pull/30506",
      note: "closed unmerged (withdrawn over a side point): restore nftables mappings on reload; the bug itself was not disputed",
    },
    {
      kind: "docs",
      url: "https://github.com/openwrt/packages/blob/openwrt-25.12/net/miniupnpd/files/miniupnpd.init",
      note: "upnp_lease_file: what a restart reads its mappings back from (the compiler sets it)",
    },
  ],
  added: "2026-10-13",
  verified: "Docker, OpenWrt 25.12.5 (miniupnpd-nftables 2.3.9-r1): mapping lost on fw4 reload, back after a restart",
  dropWhen: "miniupnpd re-adds its mappings after a firewall reload by itself (a reload hook in the package)",
  target: { roles: ["router"] },
  applies: (intent) => intent.internet.upnp,
  apply: () => ({ restarts: [{ service: "miniupnpd", after: "firewall-reload" }] }),
};
