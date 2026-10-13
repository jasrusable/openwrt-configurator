// The macOS keychain, through `security`: where secrets live on a Mac.
import type { ExecResult, Platform } from "../platform";
import { messageOf } from "../result";
import { decodeUtf8Hex } from "../utf8";
import { SecretLookup, assertSecretName } from "./refs";

export const KEYCHAIN_SERVICE = "openwrt-configurator";

export const SECURITY_PATH = "/usr/bin/security";

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
      return decodeUtf8Hex(hex);
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

export const keychainMissing = (names: string[]) =>
  `Missing keychain secrets (service ${KEYCHAIN_SERVICE}):\n` +
  names.map((name) => `  - ${name}`).join("\n") +
  `\nSet with: openwrt-configurator secrets set <name>`;

export const keychainLookup =
  (platform: Pick<Platform, "os" | "run">): SecretLookup =>
  async (name) => {
    if (platform.os !== "darwin") {
      throw new Error(
        `Keychain secret "${name}" cannot be resolved: keychain lookup is only supported on macOS.`
      );
    }
    let result: ExecResult;
    try {
      result = await platform.run([
        SECURITY_PATH,
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        name,
        "-g",
      ]);
    } catch {
      throw new Error(
        `Failed to read keychain secret "${name}": ${SECURITY_PATH} not found.`
      );
    }
    const { stdout, stderr } = result;
    if (result.code !== 0) {
      // 44 is errSecItemNotFound. The message is the portable signal. `-g`
      // prints the secret on stderr, so a failure that got that far must not
      // carry stderr into this error.
      if (result.code === 44 || /could not be found/i.test(stderr)) {
        return undefined;
      }
      const raw =
        stderr.trim() || `security exited ${result.code ?? "without a status"}`;
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
        `Failed to read keychain secret "${name}": ${
          messageOf(parseError)
        }`
      );
    }
  };

export const setKeychainSecret = async ({
  name,
  platform,
}: {
  name: string;
  platform: Pick<Platform, "os" | "runInteractive">;
}) => {
  assertSecretName(name);
  if (platform.os !== "darwin") {
    throw new Error("Keychain secrets are only supported on macOS.");
  }
  const code = await platform.runInteractive([
    SECURITY_PATH,
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    name,
    "-w",
  ]);
  if (code !== 0) {
    throw new Error(
      `Failed to store secret "${name}" (security exited ${code ?? "null"}).`
    );
  }
  console.log(
    `Stored secret "${name}" in the keychain (service ${KEYCHAIN_SERVICE}).`
  );
};
