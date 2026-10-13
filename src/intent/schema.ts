// The intent file: what the network should be, in the user's terms. It holds
// decisions only, never device facts (models, ports, radios, versions), which
// are read from the devices when they are provisioned. The UI edits this file
// and nothing else; compile.ts turns it into the low-level config. Each
// top-level key is a settings page, its shape that feature's own
// (<feature>/schema.ts); assembled here, with the checks across them.
import { z } from "zod";
import { choiceIssues } from "./choices";
import { dnsSchema } from "./dns/schema";
import type { AddIssue } from "./feature";
import { firewallSchema } from "./firewall/schema";
import { hardwareSchema } from "./hardware/schema";
import { internetSchema } from "./internet/schema";
import { featureModules } from "./modules";
import { networksSchema } from "./networks/schema";
import { systemSchema } from "./system/schema";
import { vpnSchema } from "./vpn/schema";
import { meshSchema } from "./mesh/schema";
import { wifiSchema } from "./wifi/schema";

export const intentVersion = 1;

export const intentSchema = z
  .object({
    /** This file's format version; older files are migrated (migrations.ts). */
    schema: z.literal(intentVersion),
    system: systemSchema,
    internet: internetSchema,
    networks: networksSchema,
    // The mesh's settings live under Wi-Fi's: one slice each, joined here.
    wifi: wifiSchema.extend({ mesh: meshSchema }),
    firewall: firewallSchema,
    vpn: vpnSchema,
    dns: dnsSchema,
    hardware: hardwareSchema,
  })
  .strict()
  .superRefine((intent, ctx) => {
    // Rules across settings, each feature's own, at the field they concern,
    // so the UI shows them there; then what one setting may be given the
    // rest (the rules the UI greys out by). The server applies the same
    // ones: nothing invalid is saved.
    const issue: AddIssue = (path, message) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    featureModules.forEach((feature) => feature.check?.(intent, issue));
    choiceIssues(intent).forEach(({ path, message }) => issue(path, message));
  });

export type Intent = z.infer<typeof intentSchema>;
