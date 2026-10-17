// Names: where the router looks them up, the local domain, and your own.
import { z } from "zod";
import { dnsServer, name, namePattern } from "../validators";

/**
 * A top-level domain of the internet: the router answers the whole domain
 * itself (dnsmasq's local=/<domain>/). Two letters is a country's, but for
 * ISO 3166's user-assigned codes (AA, QM-QZ, XA-XZ, ZZ), which no country
 * gets; the rest, the usual ones.
 */
const internetTld = (domain: string) =>
  (/^[a-z]{2}$/.test(domain) && !/^(aa|q[m-z]|x[a-z]|zz)$/.test(domain)) ||
  ["com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "arpa"].includes(domain);

export const dohProviders = ["cloudflare", "google", "quad9"] as const;
export type DohProvider = (typeof dohProviders)[number];

export const dnsSchema = z
  .object({
    /**
     * Where the router looks names up: the internet provider's servers,
     * a provider over encrypted DNS (DoH), or servers of your choice.
     */
    upstream: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("provider") }).strict(),
        z
          .object({
            type: z.literal("encrypted"),
            provider: z.enum(dohProviders),
            /**
             * Asked only when the provider does not answer (dns/compile.ts);
             * unset, another provider (`fallbackOf`); "none", no fallback.
             */
            fallback: z.enum([...dohProviders, "none"]).optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal("custom"),
            servers: z.array(dnsServer).min(1, "at least one server"),
          })
          .strict(),
      ])
      .default({ type: "provider" }),
    /** Devices are reachable as <name>.<domain>: one label (lan) or more (home.arpa, RFC 8375). */
    domain: z
      .string()
      .refine((d) => d.length <= 200 && d.split(".").every((label) => namePattern.test(label)), "like lan or home.arpa")
      .refine((d) => !internetTld(d), "the internet's: every name under it would be answered here, and fail; like lan or home.arpa")
      .default("lan"),
    /**
     * Refuse answers from the internet that point at your own addresses
     * (DNS rebinding), so a web page cannot reach devices inside.
     */
    rebind_protection: z.boolean().default(true),
    /** Your own names, like nas → 10.0.0.20: name.<domain>. */
    hosts: z
      .array(z.object({ name, address: z.string() }).strict())
      .default([]),
  })
  .strict()
  .default({});
