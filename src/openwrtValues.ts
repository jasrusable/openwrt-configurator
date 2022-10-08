export const firewallProtocols = [
  "tcp",
  "udp",
  "udplite",
  "icmp",
  "esp",
  "ah",
  "sctp",
  "igmp",
] as const;

export const firewallTargets = ["ACCEPT", "REJECT", "DROP"] as const;

export const icmpTypes = [
  "130/0",
  "131/0",
  "132/0",
  "143/0",
  "echo-request",
  "echo-reply",
  "destination-unreachable",
  "packet-too-big",
  "time-exceeded",
  "bad-header",
  "unknown-header-type",
  "router-solicitation",
  "neighbour-solicitation",
  "router-advertisement",
  "neighbour-advertisement",
] as const;

export const htModes = [
  {
    name: "HT20",
    bands: ["2g"],
  },
  {
    name: "HT40",
    bands: ["2g"],
  },
  {
    name: "VHT20",
    bands: ["5g"],
  },
  {
    name: "VHT40",
    bands: ["5g"],
  },
  {
    name: "VHT80",
    bands: ["5g"],
  },
] as const;

export const allHtModes = ["HT20", "HT40", "VHT20", "VHT40", "VHT80"] as const;

export const wifiBands = ["2g", "5g", "6g"] as const;

export const wifiTypes = ["mac80211"] as const;
