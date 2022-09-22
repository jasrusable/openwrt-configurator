import { z } from "zod";

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

export const ports = z.union([z.array(z.number()), z.string()]);
