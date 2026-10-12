// Device facts (what each device is, as last read), put in words for the
// pages and hints that show them. Facts only ever inform: nothing the user
// sets depends on them (CLAUDE.md, "Reading devices").
import type { DeviceSchema } from "../../src/deviceSchema";
import type { Intent } from "../../src/intent/schema";
import type { FactsByDevice } from "./data/api";

/** "FriendlyElec NanoPi R6S", or its board id when the board gives no name. */
export const modelOf = (schema: DeviceSchema) => schema.model ?? schema.name;

const bandNames: Record<string, string> = { "2g": "2.4 GHz", "5g": "5 GHz", "6g": "6 GHz", "60g": "60 GHz" };

/** Its radios' bands, as people say them: "2.4 GHz, 5 GHz". */
export const bandsOf = (schema: DeviceSchema) =>
  [...new Set((schema.radios ?? []).map((r) => r.band))].map((b) => bandNames[b] ?? b);

/** Its ports by role: the internet's (WAN) and the networks' (LAN). */
export const portsOf = (schema: DeviceSchema) => ({
  wan: (schema.ports ?? []).filter((p) => p.default_role === "wan").map((p) => p.name),
  lan: (schema.ports ?? []).filter((p) => p.default_role !== "wan").map((p) => p.name),
});

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export const ago = (ms: number, now = Date.now()) => {
  const minutes = Math.round((now - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/** The router and what it is, if it has been read. */
export const routerFacts = (intent: Intent | undefined, facts: FactsByDevice | undefined) => {
  const router = intent?.hardware.find((d) => d.role === "router");
  const known = router && facts?.[router.name];
  return router && known ? { name: router.name, schema: known.schema } : undefined;
};
