import { Platform } from "../platform";

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

const macPattern = /\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/gi;

/**
 * This machine's own MACs: an access point listing one among its Wi-Fi
 * clients is the one this machine reaches the network through.
 */
export const ownMacs = async (platform: Pick<Platform, "os" | "run">): Promise<string[]> => {
  try {
    const { stdout } =
      platform.os === "darwin" ? await platform.run(["ifconfig"]) : await platform.run(["ip", "-o", "link"]);
    const lines = stdout.split("\n").filter((line) => /\b(ether|link\/ether)\s/.test(line));
    return [...new Set(lines.flatMap((line) => [...line.matchAll(macPattern)].map((m) => m[1].toLowerCase())))].filter(
      (mac) => mac !== "00:00:00:00:00:00" && mac !== "ff:ff:ff:ff:ff:ff"
    );
  } catch {
    return [];
  }
};
