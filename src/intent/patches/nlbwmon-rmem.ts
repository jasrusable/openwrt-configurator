import { Patch } from "./patch";

const file = "/etc/sysctl.d/12-onc-nlbwmon.conf";

export const nlbwmonRmem: Patch = {
  id: "nlbwmon-rmem",
  title: "Traffic counting kept working on a busy network",
  affects: [],
  why:
    "nlbwmon asks for a 512 KiB netlink receive buffer (its stock netlink_buffer_size), " +
    "but the kernel caps it at net.core.rmem_max, 208 KiB, and the package raises " +
    "nothing. With a few thousand connections tracked, every conntrack dump then " +
    "overflows ('Unable to dump conntrack: No buffer space available' each minute) " +
    "and no device's traffic is counted. rmem_max is raised to the buffer it asks for, " +
    "and nlbwmon restarted to take it.",
  kind: "fix",
  references: [
    { kind: "docs", url: "https://github.com/jow-/nlbwmon", note: "nlbwmon logs that rmem_max must be at least its netlink_buffer_size" },
    {
      kind: "docs",
      url: "https://github.com/openwrt/packages/blob/openwrt-25.12/net/nlbwmon/Makefile",
      note: "the package installs no sysctl.d file",
    },
  ],
  added: "2026-10-20",
  verified: "the user's NanoPi R6S on 25.12.6: about 4,900 connections tracked, every dump failing, rmem_max 212992",
  dropWhen: "the nlbwmon package raises net.core.rmem_max itself",
  target: { roles: ["router"] },
  apply: () => ({
    files: [
      {
        path: file,
        content: "# nlbwmon's netlink_buffer_size: the kernel caps a socket's buffer here.\nnet.core.rmem_max=524288\n",
        runAfter: `sysctl -q -p ${file} && { [ ! -x /etc/init.d/nlbwmon ] || /etc/init.d/nlbwmon restart; }`,
      },
    ],
  }),
};
