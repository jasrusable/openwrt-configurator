// What the internet lines may be, given the rest: the first line carries
// IPv6, a port carries one line per VLAN, and the settings about several lines only
// mean something with several.
import type { Choice } from "../feature";
import { internetIpv6, multiWan, networkHasIpv6, primaryConnection, roomIn, samePort } from "../connections";
import type { Intent } from "../schema";

/** An earlier line on `port` with line `c`'s VLAN. */
const earlierOnPort = (intent: Intent, c: number, port: string | undefined) =>
  intent.internet.lines.slice(0, c).find((o) => samePort(o, { port, vlan: intent.internet.lines[c]?.vlan }));

export const internetRules: Choice[] = [
  {
    path: "internet.lines.*.ipv6.prefix",
    values: ["48", "56", "60", "64"],
    unavailable: (intent, [c], prefix) => {
      const want = intent.networks.filter((n) => networkHasIpv6(intent, n)).length;
      const room = roomIn(prefix);
      return (
        c === "0" &&
        internetIpv6(intent) &&
        want > room &&
        `${want} networks have IPv6, and a /${prefix} has room for ${room}.`
      );
    },
  },
  {
    // The networks' IPv6 comes from the main line alone: two providers'
    // prefixes at once leave clients on a dead one when a line fails.
    path: "internet.lines.*.ipv6.enabled",
    unavailable: (intent, [c]) =>
      c !== "0" && `Your networks get IPv6 from the first line, ${primaryConnection(intent).name || "the main one"}.`,
    refuses: false,
  },
  {
    path: "internet.lines.*.ipv6.prefix",
    unavailable: (intent, [c]) => c !== "0" && "Only the first line's prefix is used.",
    refuses: false,
  },
  {
    // A port carries one line per VLAN (one untagged): reported at the later
    // of two (the UI greys a port another line uses, with portTakenBy).
    path: "internet.lines.*.port",
    unavailable: (intent, [c], port) => {
      const other = port !== undefined && earlierOnPort(intent, Number(c), port);
      return other && `${other.name || "Another line"} uses it${other.vlan ? ` with VLAN ${other.vlan}` : ""}.`;
    },
  },
  {
    // Unset is the router's WAN port: the earliest line there keeps it.
    path: "internet.lines.*.port",
    values: [undefined],
    unavailable: (intent, [c]) => {
      const other = earlierOnPort(intent, Number(c), undefined);
      return other && `${other.name || "Another line"} uses the WAN port${other.vlan ? ` with VLAN ${other.vlan}` : ""}.`;
    },
  },
  {
    path: "internet.lines.*.failover.metered",
    unavailable: (intent) => !multiWan(intent) && "With one line it is used for everything anyway.",
    refuses: false,
  },
  {
    // IPv6 goes out the first line alone: a metered one would carry all of
    // it, all the time, never only as a last resort.
    path: "internet.lines.*.failover.metered",
    values: [true],
    unavailable: (intent, [c]) =>
      c === "0" &&
      multiWan(intent) &&
      internetIpv6(intent) &&
      "The first line carries all your IPv6, so it would never be only a backup: put another line first, or turn its IPv6 off.",
  },
  {
    path: "internet.lines.*.failover.down_when_slow",
    unavailable: (intent) => !multiWan(intent) && "With one line there is nothing to switch to.",
    refuses: false,
  },
  {
    path: "internet.use_lines.sticky_per_device",
    unavailable: (intent) =>
      (!multiWan(intent) || intent.internet.use_lines.mode !== "balance") && "Only used when lines share traffic.",
    refuses: false,
  },
  {
    path: "internet.use_lines.mode",
    unavailable: (intent) => !multiWan(intent) && "With one line there is nothing to share or fail over to.",
    refuses: false,
  },
  {
    path: "internet.lines.*.failover.weight",
    unavailable: (intent) =>
      (!multiWan(intent) || intent.internet.use_lines.mode !== "balance") && "Only used when lines share traffic.",
    refuses: false,
  },
];
