import { Platform } from "./platform";

/**
 * The machine's default gateway, if it can tell. Devices are provisioned with
 * the gateway (normally the router) last: changing it first could cut the
 * path to every device behind it before they have been touched.
 */
export const defaultGateway = async (
  platform: Pick<Platform, "os" | "run">
): Promise<string | undefined> => {
  try {
    if (platform.os === "darwin") {
      const { stdout } = await platform.run(["route", "-n", "get", "default"]);
      return /gateway:\s*(\S+)/.exec(stdout)?.[1];
    }
    const { stdout } = await platform.run(["ip", "route", "show", "default"]);
    return /default via (\S+)/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
};
