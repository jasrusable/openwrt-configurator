// Every device located (src/locate.ts) and read at once, each within a time
// limit, so one slow device cannot hold up the rest. Where a device was found
// is remembered with its facts; nothing it says is stored.
import { clearFailure, DeviceFacts, factsMaxAgeMs, rememberLocated } from "./deviceFacts";
import { Located, locateEach } from "./locate";
import { Platform } from "./platform";
import { ProvisionableDevice } from "./provisionConfig";

export const readEach = <T>({
  intentPath,
  platform,
  devices,
  facts,
  timeoutMs,
  now = Date.now,
  read,
  failed,
}: {
  intentPath: string;
  platform: Platform;
  devices: ProvisionableDevice[];
  facts: Record<string, DeviceFacts | undefined>;
  timeoutMs: number;
  now?: () => number;
  read: (found: Located) => Promise<T>;
  failed: (hostname: string, error: string) => T;
}): Promise<T[]> =>
  Promise.all(
    locateEach({ devices, facts, platform }).map((found, i) => {
      const { hostname } = devices[i];
      // Both settle to a result, never a rejection: the loser of the race
      // settles later with no one listening, which must not crash the server.
      // The session is closed however late the device answers, and if it
      // answers then hangs, when the time is up.
      let session: Located["session"] | undefined;
      const attempt = found
        .then(async (f): Promise<T> => {
          if (!("session" in f)) return failed(hostname, f.error);
          session = f.session;
          try {
            const known = facts[hostname];
            if (!known || known.address !== f.address || now() - known.readAt > factsMaxAgeMs) {
              rememberLocated(platform, intentPath, f, now());
              clearFailure(platform, intentPath, hostname);
            }
            return await read(f);
          } finally {
            f.session.dispose();
          }
        })
        .catch((e) => failed(hostname, (e as Error).message));
      const late = platform.sleep(timeoutMs).then(() => {
        try {
          session?.dispose();
        } catch {
          // Already closed.
        }
        return failed(hostname, "did not answer in time");
      });
      return Promise.race([attempt, late]);
    })
  );
