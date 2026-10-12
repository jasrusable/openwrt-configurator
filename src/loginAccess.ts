// Who may log in to the devices is the intent's (admin.authorized_keys,
// admin.password_login); this app logs in with admin.ssh_key_path. An apply
// that turns password login off without this app's own key authorized would
// lock it out, so it is refused before any device is touched.
import type { Intent } from "./intent/schema";
import { Platform } from "./platform";
import { expandHome } from "./provisionConfig";
import { where } from "./intent/places";
import { keyIdentity } from "./sshKeys";

/** This app's public key: the private key's .pub beside it, or ssh-keygen's reading of it. */
export const ownPublicKey = async (
  platform: Pick<Platform, "readTextFile" | "run" | "homedir">,
  keyPath: string
): Promise<string | undefined> => {
  const path = expandHome(keyPath, platform.homedir());
  try {
    return platform.readTextFile(`${path}.pub`).trim();
  } catch {
    // No .pub beside it: ask ssh-keygen, where there is one.
  }
  try {
    const derived = await platform.run(["ssh-keygen", "-y", "-f", path]);
    return derived.code === 0 && derived.stdout.trim() ? derived.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
};

/** Why applying `intent` would lock this app out, if it would. */
export const lockoutReason = async (
  intent: Intent,
  platform: Pick<Platform, "readTextFile" | "run" | "homedir">
): Promise<string | undefined> => {
  if (intent.admin.password_login) return undefined;
  const keyPath = intent.admin.ssh_key_path;
  if (!keyPath) {
    return `Password login would be off, but this app has no SSH key to log in with (${where("system", "Administration", "SSH key")}).`;
  }
  const own = await ownPublicKey(platform, keyPath);
  if (!own) return `Password login would be off, but this app's public key could not be read (${keyPath}.pub).`;
  return intent.admin.authorized_keys.some((k) => keyIdentity(k) === keyIdentity(own))
    ? undefined
    : `Password login would be off, and this app's key is not among the authorized keys: applying would lock it out. Add it under ${where("system", "Authorized keys")}.`;
};
