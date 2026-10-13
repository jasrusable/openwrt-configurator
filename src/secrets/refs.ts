// `{ "$secret": "name" }` refs in a config: checked, looked up (sequentially,
// so a keychain prompt cannot stack per secret) and put in place.
import { fail, Problem } from "../problem";
import { messageOf, ok, Result } from "../result";
import { isPlainObject } from "../json";
import { keychainMissing } from "./keychain";

/** Account names stored in the keychain and referenced as `{ "$secret": "name" }`. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9._@/-]+$/;

const SECRET_NAME_MAX = 128;

export type SecretLookup = (name: string) => Promise<string | undefined>;

export const assertSecretName = (name: string) => {
  if (
    !SECRET_NAME_PATTERN.test(name) ||
    name.length < 1 ||
    name.length > SECRET_NAME_MAX
  ) {
    throw new Error(
      `Invalid secret name "${name}" (use 1–128 letters, digits, . _ @ / -).`
    );
  }
};

export const hasSecretKey = (value: Record<string, unknown>) =>
  Object.prototype.hasOwnProperty.call(value, "$secret");

export const childPath = (path: string, key: string | number) => {
  if (typeof key === "number") {
    return `${path}[${key}]`;
  }
  return path === "" ? key : `${path}.${key}`;
};

const invalidRefMessage = (
  path: string,
  value: Record<string, unknown>
): string | undefined => {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "$secret") {
    return `${path}: $secret object must contain only { "$secret": "name" }`;
  }
  const name = value.$secret;
  if (typeof name !== "string") {
    return `${path}: $secret must be a string`;
  }
  try {
    assertSecretName(name);
  } catch (e) {
    return `${path}: ${messageOf(e)}`;
  }
  return undefined;
};

const collectSecretRefs = (
  value: unknown,
  path: string,
  names: Set<string>,
  errors: string[]
) => {
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      collectSecretRefs(item, childPath(path, i), names, errors)
    );
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  if (hasSecretKey(value)) {
    const error = invalidRefMessage(path || "$", value);
    if (error) {
      errors.push(error);
      return;
    }
    names.add(value.$secret as string);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectSecretRefs(child, childPath(path, key), names, errors);
  }
};

const substituteSecrets = (
  value: unknown,
  secrets: Map<string, string>
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => substituteSecrets(item, secrets));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (hasSecretKey(value) && Object.keys(value).length === 1) {
    return secrets.get(value.$secret as string);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      substituteSecrets(child, secrets),
    ])
  );
};

/** Where `$secret` refs are looked up, and what to tell the user when some are missing. */
export type SecretSource = {
  lookup: SecretLookup;
  describeMissing: (names: string[]) => string;
};

/**
 * Every `$secret` ref replaced by its value. A malformed ref is the file's
 * own mistake (invalid); a secret that is missing or cannot be read is this
 * machine's (internal).
 */
export const resolveSecrets = async (
  value: unknown,
  lookup: SecretLookup,
  describeMissing: (names: string[]) => string = keychainMissing
): Promise<Result<{ value: unknown; secrets: Map<string, string> }, Problem>> => {
  const names = new Set<string>();
  const errors: string[] = [];
  collectSecretRefs(value, "", names, errors);
  if (errors.length > 0) {
    return fail("invalid", `Invalid $secret references:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  const secrets = new Map<string, string>();
  const missing: string[] = [];
  // Sequential so a Keychain GUI prompt cannot stack per secret.
  for (const name of names) {
    let resolved: string | undefined;
    try {
      resolved = await lookup(name);
    } catch (thrown) {
      return fail("internal", messageOf(thrown));
    }
    if (resolved === undefined) {
      missing.push(name);
    } else {
      secrets.set(name, resolved);
    }
  }
  if (missing.length > 0) return fail("internal", describeMissing([...missing].sort()));

  return ok({ value: substituteSecrets(value, secrets), secrets });
};
