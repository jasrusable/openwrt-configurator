// What each device is (facts): as last read, which last read failed, and
// which are stale (GET); a read of the stale ones now, read-only, which a
// page that shows facts asks for as it opens (POST). And this app's own
// public key, beside its saved SSH key, so the UI can offer to authorize it.
import { readFacts, readFailures, staleDevices } from "../../deviceFacts";
import { ownPublicKey } from "../../loginAccess";
import { refreshStale } from "../../readEach";
import { ApiContext, json, Route } from "../router";
import { intentFileOrNothing } from "../../settings";

export const devicesRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => {
  const facts = () => {
    const intent = intentFileOrNothing(platform, intentPath) as { hardware?: { name: string }[] } | undefined;
    const names = (intent?.hardware ?? []).map((d) => d.name);
    const known = readFacts(platform, intentPath, names);
    const failures = readFailures(platform, intentPath, names);
    return json(200, { facts: known, failures, stale: staleDevices({ facts: known, failures, now: now() }) });
  };
  return [
    {
      path: "/api/devices",
      GET: async () => facts(),
      POST: async () => {
        await refreshStale({ intentPath, platform, now });
        return facts();
      },
    },
    {
      path: "/api/admin/key",
      GET: async () => {
        const intent = intentFileOrNothing(platform, intentPath) as { system?: { app_login?: { key?: string } } } | undefined;
        const keyPath = intent?.system?.app_login?.key;
        return json(200, { publicKey: (keyPath ? await ownPublicKey(platform, keyPath) : undefined) ?? null });
      },
    },
  ];
};
