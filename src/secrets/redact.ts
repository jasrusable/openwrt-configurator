// Hiding secrets in what is printed: a value resolved from a ref wherever it
// appears, and every value secretOptions.ts calls secret by its place.
import { isPlainObject } from "../json";
import { isSecretSource, redactedText } from "../secretOptions";

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
 * A field that holds a secret, judged as everywhere else (secretOptions.ts):
 * by its name, or as the content of an owner-only file. A number is one as
 * much as a string (a numeric password); a flag never is.
 */
export const isSecretField = (key: string, child: unknown, parent: Record<string, unknown>): child is string | number =>
  (typeof child === "number" || (typeof child === "string" && child.length > 0)) &&
  isSecretSource(
    key === "content" && typeof parent.path === "string"
      ? { file: { mode: typeof parent.mode === "string" ? parent.mode : undefined } }
      : { option: key }
  );

/** A copy with every secret value replaced, for printing. */
export const redactSecretFields = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(redactSecretFields)
    : isPlainObject(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          isSecretField(key, child, value) ? redactedText : redactSecretFields(child),
        ])
      )
    : value;
