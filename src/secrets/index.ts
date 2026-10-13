// Secrets: `$secret` refs resolved from where this host keeps them (the
// macOS keychain, else a 0600 file), and hidden again in what is printed.
import type { Platform } from "../platform";
import { DEFAULT_SECRETS_FILE, secretsFileSource } from "./file";
import { keychainLookup, keychainMissing } from "./keychain";
import type { SecretSource } from "./refs";

export { DEFAULT_SECRETS_FILE, secretsFileSource } from "./file";
export { KEYCHAIN_SERVICE, SECURITY_PATH, keychainLookup, parseSecurityPassword, setKeychainSecret, stripOneTrailingNewline } from "./keychain";
export { findPlaintextSecrets } from "./plaintext";
export { redactSecretFields, redactValue } from "./redact";
export { SECRET_NAME_PATTERN, assertSecretName, resolveSecrets, secretRefNames } from "./refs";
export type { SecretLookup, SecretSource } from "./refs";

/** The macOS keychain on macOS; elsewhere a 0600 JSON file. */
export const defaultSecretSource = (platform: Platform): SecretSource =>
  platform.os === "darwin"
    ? { lookup: keychainLookup(platform), describeMissing: keychainMissing }
    : secretsFileSource({
        path: platform.env("ONC_SECRETS_FILE") ?? DEFAULT_SECRETS_FILE,
        platform,
      });
