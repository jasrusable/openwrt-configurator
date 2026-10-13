// Who may log in to the devices is the intent's (system.ssh.authorized_keys,
// system.ssh.password_login); this app logs in with system.app_login.key. An apply
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

/**
 * Why applying `intent` would lock this app out, if it would: after it, the
 * app must still get in, by password (login on, and a password to send) or
 * by its key (authorized, when the list is the intent's; with none listed
 * the device's own file is left, and with it whatever got the app in).
 */
export const lockoutReason = async (
  intent: Intent,
  platform: Pick<Platform, "readTextFile" | "run" | "homedir">
): Promise<string | undefined> => {
  const { password_login, authorized_keys: keys } = intent.system.ssh;
  const { password, key: keyPath } = intent.system.app_login;
  if (password_login && password) return undefined;
  const off = password_login ? "This app has no password to log in with" : "Password login would be off";
  if (!keyPath) {
    return `${off}, and no SSH key to log in with either (${where("system", "Administration", "SSH key")}).`;
  }
  if (password_login && keys.length === 0) return undefined;
  const own = await ownPublicKey(platform, keyPath);
  if (!own) return `${off}, and this app's public key could not be read (${keyPath}.pub).`;
  return keys.some((k) => keyIdentity(k) === keyIdentity(own))
    ? undefined
    : `${off}, and this app's key is not among the authorized keys: applying would lock it out. Add it under ${where("system", "Authorized keys")}.`;
};
