// Names: where the router looks them up, the local domain, and your own.
import { z } from "zod";
import { dnsServer, name, namePattern } from "../validators";

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
            provider: z.enum(["cloudflare", "google", "quad9"]),
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
