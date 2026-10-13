// Every fix this app layers over OpenWrt (src/intent/patches), and where it
// applies on each device: the saved settings and the stored facts, no
// device read (the Fixes page works the same out from the draft).
import { readFacts } from "../../deviceFacts";
import { patchStatus } from "../../intent/patches/status";
import { loadSettings } from "../../settings";
import { ApiContext, json, refuse, Route } from "../router";

export const patchesRoutes = ({ intentPath, platform }: ApiContext): Route[] => [
  {
    path: "/api/patches",
    GET: async () => {
      const loaded = await loadSettings(intentPath, platform);
      if (!loaded.ok) return refuse(loaded.error.kind, loaded.error.message);
      const { intent } = loaded.value;
      if (!intent) return refuse("invalid", "Fixes apply to intent files only.");
      const facts = readFacts(platform, intentPath, intent.hardware.map((d) => d.name));
      return json(200, { patches: patchStatus(intent, facts) });
    },
  },
];
