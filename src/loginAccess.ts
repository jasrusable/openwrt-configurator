// Who may log in to the devices is the intent's (system.ssh.authorized_keys,
// system.ssh.password_login); this app logs in with system.app_login.key. An apply
// that turns password login off without this app's own key authorized would
// lock it out, so it is refused before any device is touched.
import type { Intent } from "./intent/schema";
import { Platform } from "./platform";
import { expandHome, isPublicKeyPath } from "./apply/provisionConfig";
import { where } from "./intent/places";
import { keyIdentity } from "./sshKeys";

/** This app's public key: the file itself when it is one (the agent's key), else the private key's .pub beside it, or ssh-keygen's reading of it. */
export const ownPublicKey = async (
  platform: Pick<Platform, "readTextFile" | "run" | "homedir">,
  keyPath: string
): Promise<string | undefined> => {
  const path = expandHome(keyPath, platform.homedir());
  try {
    return platform.readTextFile(isPublicKeyPath(path) ? path : `${path}.pub`).trim();
  } catch {
    // No .pub beside it: ask ssh-keygen, where there is one.
  }
  try {
    // -P "": a key with a passphrase fails rather than asking for it, and
    // the time limit ends whatever else would hang an API request.
    const derived = await platform.run(["ssh-keygen", "-y", "-P", "", "-f", path], { timeoutMs: 10_000 });
    return derived.code === 0 && derived.stdout.trim() ? derived.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Why applying `intent` would lock this app out, if it would: after it, the
 * app must still get in, by password (login on, and a password to send) or
 * by its key, among the authorized keys (none listed is not counted on: a
 * file an earlier apply installed is then removed).
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
  const own = await ownPublicKey(platform, keyPath);
  if (!own) return `${off}, and this app's public key could not be read (${keyPath}.pub).`;
  return keys.some((k) => keyIdentity(k) === keyIdentity(own))
    ? undefined
    : `${off}, and this app's key is not among the authorized keys: applying would lock it out. Add it under ${where("system", "Authorized keys")}.`;
};

/** The public half of the key this app logs in with (system.app_login.key), when it can be read. */
export const appPublicKey = async (
  intent: Pick<Intent, "system">,
  platform: Pick<Platform, "readTextFile" | "run" | "homedir">
): Promise<string | undefined> => (intent.system.app_login.key ? ownPublicKey(platform, intent.system.app_login.key) : undefined);
