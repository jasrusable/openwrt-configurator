// A warning for a low-level config that keeps a credential in plain text,
// where a `$secret` ref would keep it out of the file.
import { isPlainObject } from "../json";
import { isSecretField } from "./redact";
import { childPath, hasSecretKey } from "./refs";

/**
 * Not worth a warning, though printing hides them all: a file's name
 * (uhttpd's /etc/uhttpd.key, an SSH key's path), a login's user name (SSH's
 * root), or a switch (dropbear's PasswordAuth "on").
 */
const worthWarning = (key: string, value: string) =>
  !/^[/~]/.test(value) && !/(user(name)?|path|file)$/i.test(key) && !/^(on|off|0|1|yes|no|true|false)$/i.test(value);

export const findPlaintextSecrets = (value: unknown, path = ""): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) =>
      findPlaintextSecrets(item, childPath(path, i))
    );
  }
  if (!isPlainObject(value) || hasSecretKey(value)) {
    return [];
  }
  const hits: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childP = childPath(path, key);
    if (isSecretField(key, child, value) && worthWarning(key, child)) {
      hits.push(childP);
    }
    hits.push(...findPlaintextSecrets(child, childP));
  }
  return hits;
};
