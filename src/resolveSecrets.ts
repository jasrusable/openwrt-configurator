import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = "openwrt-configurator";
export const SECURITY_PATH = "/usr/bin/security";

/** Account names stored in the keychain and referenced as `{ "$secret": "name" }`. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9._@/-]+$/;
const SECRET_NAME_MAX = 128;

export type SecretLookup = (name: string) => Promise<string | undefined>;

export const stripOneTrailingNewline = (s: string) => {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
};

/**
 * Decode one `find-generic-password -g` line.
 *
 * `-w` prints non-printable values as bare hex, so a hex passphrase and a
 * hex dump of a non-ASCII value look the same. `-g` quotes a literal value
 * and prefixes a dump with `0x`. Returns undefined when there is no line.
 */
export const parseSecurityPassword = (output: string): string | undefined => {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trimStart())
    .find((entry) => entry.startsWith("password: "));
  if (line === undefined) return undefined;
  const rest = line.slice("password: ".length);
  if (rest.startsWith("0x") || rest.startsWith("0X")) {
    const hex = /^[0-9a-fA-F]*/.exec(rest.slice(2))?.[0] ?? "";
    if (hex.length === 0 || hex.length % 2 !== 0) {
      throw new Error("security printed a truncated hex password");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(hex, "hex")
      );
    } catch {
      throw new Error("security hex password is not valid UTF-8");
    }
  }
  if (rest.startsWith('"')) return unquoteSecurityPassword(rest);
  throw new Error("security printed a password in an unrecognized form");
};

const unquoteSecurityPassword = (rest: string) => {
  let out = "";
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') return out;
    if (c === "\\") {
      const next = rest[i + 1];
      if (next !== "\\" && next !== '"') {
        throw new Error("security printed an unknown password escape");
      }
      out += next;
      i++;
      continue;
    }
    out += c;
  }
  throw new Error("security printed an unterminated password");
};

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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasSecretKey = (value: Record<string, unknown>) =>
  Object.prototype.hasOwnProperty.call(value, "$secret");

const childPath = (path: string, key: string | number) => {
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
    return `${path}: ${(e as Error).message}`;
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

export const resolveSecrets = async (
  value: unknown,
  lookup: SecretLookup
): Promise<{ value: unknown; secrets: Map<string, string> }> => {
  const names = new Set<string>();
  const errors: string[] = [];
  collectSecretRefs(value, "", names, errors);
  if (errors.length > 0) {
    throw new Error(
      `Invalid $secret references:\n${errors.map((e) => `  - ${e}`).join("\n")}`
    );
  }

  const secrets = new Map<string, string>();
  const missing: string[] = [];
  // Sequential so a Keychain GUI prompt cannot stack per secret.
  for (const name of names) {
    const resolved = await lookup(name);
    if (resolved === undefined) {
      missing.push(name);
    } else {
      secrets.set(name, resolved);
    }
  }
  if (missing.length > 0) {
    missing.sort();
    throw new Error(
      `Missing keychain secrets (service ${KEYCHAIN_SERVICE}):\n` +
        missing.map((name) => `  - ${name}`).join("\n") +
        `\nSet with: openwrt-configurator secrets set <name>`
    );
  }

  return { value: substituteSecrets(value, secrets), secrets };
};

/**
 * Placeholder for a value that was loaded from the keychain, otherwise the
 * value itself.
 *
 * Match the whole emitted value, before shell quoting. A substring replace
 * rewrites unrelated text that merely contains the secret, and quoting splits
 * apostrophes so the secret is no longer one span. Names that share a value
 * become one token — labeling every copy with whichever name was inserted
 * first would be wrong.
 */
export const redactValue = (
  value: string,
  secrets: Map<string, string>
): string => {
  if (value.length === 0) return value;
  const names = [...secrets.entries()]
    .filter(([, secret]) => secret === value)
    .map(([name]) => name)
    .sort();
  if (names.length === 0) return value;
  return `{ $secret: ${names.join(", ")} }`;
};

/**
 * Paths of plaintext `password` / `key` string fields. Used as a migration
 * warning; tests and samples may still use placeholders.
 */
export const findPlaintextSecrets = (
  value: unknown,
  path = ""
): string[] => {
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
    if (
      (key === "password" || key === "key") &&
      typeof child === "string" &&
      child.length > 0
    ) {
      hits.push(childP);
    }
    hits.push(...findPlaintextSecrets(child, childP));
  }
  return hits;
};

export const lookupKeychain: SecretLookup = async (name) => {
  if (process.platform !== "darwin") {
    throw new Error(
      `Keychain secret "${name}" cannot be resolved: keychain lookup is only supported on macOS.`
    );
  }
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      SECURITY_PATH,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-g"],
      { encoding: "utf8" }
    );
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (e: unknown) {
    const err = e as {
      code?: number | string;
      stderr?: string;
      message?: string;
    };
    const failure = typeof err.stderr === "string" ? err.stderr : "";
    // 44 is errSecItemNotFound. The message is the portable signal. `-g`
    // prints the secret on stderr, so a failure that got that far must not
    // carry stderr into this error.
    if (err.code === 44 || /could not be found/i.test(failure)) {
      return undefined;
    }
    if (err.code === "ENOENT") {
      throw new Error(
        `Failed to read keychain secret "${name}": ${SECURITY_PATH} not found.`
      );
    }
    const raw = failure.trim() || err.message || "unknown error";
    const detail = /^password: /m.test(raw)
      ? "security failed after printing a password"
      : raw;
    throw new Error(`Failed to read keychain secret "${name}": ${detail}`);
  }
  // The password line is on stderr; stdout is the attribute dump. Never
  // include either in an error — stderr is the secret.
  try {
    const parsed =
      parseSecurityPassword(stderr) ?? parseSecurityPassword(stdout);
    if (parsed === undefined) {
      throw new Error("security did not print a password");
    }
    return parsed;
  } catch (parseError) {
    throw new Error(
      `Failed to read keychain secret "${name}": ${(parseError as Error).message}`
    );
  }
};

export const setKeychainSecret = async (name: string) => {
  assertSecretName(name);
  if (process.platform !== "darwin") {
    throw new Error("Keychain secrets are only supported on macOS.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      SECURITY_PATH,
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        name,
        "-w",
      ],
      { stdio: "inherit" }
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        console.log(
          `Stored secret "${name}" in the keychain (service ${KEYCHAIN_SERVICE}).`
        );
        resolve();
        return;
      }
      reject(
        new Error(
          `Failed to store secret "${name}" (security exited ${code ?? "null"}).`
        )
      );
    });
  });
};
