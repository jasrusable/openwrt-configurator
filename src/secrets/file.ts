// A 0600 JSON file of `{ "name": "value" }`: where secrets live on a host
// without a keychain, such as an OpenWrt device.
import type { Platform } from "../platform";
import type { SecretSource } from "./refs";

/** Where secrets live on a host without a keychain, such as an OpenWrt device. */
export const DEFAULT_SECRETS_FILE = "/etc/onc/secrets.json";

/**
 * Secrets from a JSON file of `{ "name": "value" }`, which must not be readable
 * by anyone but its owner (like an SSH private key).
 */
export const secretsFileSource = ({
  path,
  platform,
}: {
  path: string;
  platform: Pick<Platform, "fileMode" | "readTextFile">;
}): SecretSource => {
  let cache: Record<string, unknown> | undefined;
  const load = () => {
    if (cache) return cache;
    const mode = platform.fileMode(path);
    if (mode === undefined) return (cache = {});
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${path} is accessible to other users (mode ${mode.toString(
          8
        )}); run: chmod 600 ${path}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(platform.readTextFile(path));
    } catch {
      // Deliberately no position or excerpt: the offending line is a secret.
      throw new Error(`${path} is not valid JSON.`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${path} must be a JSON object of secret name to value.`);
    }
    return (cache = parsed as Record<string, unknown>);
  };
  return {
    lookup: async (name) => {
      const secrets = load();
      if (!Object.prototype.hasOwnProperty.call(secrets, name))
        return undefined;
      const value = secrets[name];
      if (typeof value !== "string") {
        throw new Error(`Secret "${name}" in ${path} must be a string.`);
      }
      return value;
    },
    describeMissing: (names) =>
      `Missing secrets in ${path}:\n` +
      names.map((name) => `  - ${name}`).join("\n") +
      `\nAdd them to that file as { "name": "value" }, with mode 0600.`,
  };
};
