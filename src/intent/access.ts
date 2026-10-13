// Who may reach what, in a home network's terms: each network's `access`
// (and remote access's and linked sites', like a network's), and the names
// a rule or an access can point at besides networks. Shared by the
// networks, the VPN and the firewall, which compiles it (firewall/compile.ts).
import { z } from "zod";

/** Where a rule's traffic comes from: a network's id, the internet, or anywhere. */
export const internet = "internet";
export const anywhere = "*";
/** A rule's destination may also be the router itself. */
export const router = "router";
/** The zones remote access ("vpn") and linked sites ("sites") add: targets of an access, like networks. */
export const remoteAccessZone = "vpn";
export const sitesZone = "sites";
export const vpnZoneIds = [remoteAccessZone, sitesZone];
/** Not usable as a network id: rules use them. */
export const reservedIds = [internet, router, "wan"];

/** What a network may reach: the internet, other networks, the router. */
export const accessSchema = z
  .object({
    internet: z.boolean().default(true),
    /** Ids of the networks it may open connections to. Replies always pass. */
    networks: z.array(z.string()).default([]),
    /** "full": anything on the router, its admin included. "services": DHCP, DNS and time only. */
    router: z.enum(["full", "services"]).default("services"),
  })
  .strict();

export type Access = z.infer<typeof accessSchema>;

/**
 * A network's: also which way its internet goes, with several lines or a VPN
 * provider: `via` a line's or provider's id, with the others as `fallback`
 * when it is down (never for a provider: its kill switch). Unset, the
 * internet's mode decides.
 */
export const networkAccessSchema = accessSchema
  .extend({
    via: z.string().min(1, "pick a line").optional(),
    fallback: z.boolean().default(true),
  })
  .strict();

