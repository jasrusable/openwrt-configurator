// Which values are secrets, decided once for every place that prints or
// shows config: the dry run, `compile`, the apply diff and the plaintext
// warning. Matched broadly by option name, since configs hold packages'
// options this app does not know (802.11r's r0kh/r1kh carry keys, WEP has
// key1-4, acme keeps API tokens in credentials): hiding a harmless one only
// costs showing it hidden.

/** Whether a UCI option (or JSON field) of this name holds a secret. */
export const isSecretOption = (option: string) =>
  // username: a PPPoE or VPN login is half the credential; pincode a SIM's.
  /key|secret|pass|psk|token|credential|r[01]kh|priv|auth(?!oritative)|user(name)?$|pincode|param_enc/i.test(option);

/** Where a printed value comes from, so a redactor can tell a secret by its place. */
export type SecretSource = { option: string } | { file: { mode?: string } };

/** A file only its owner may read holds secrets (a WireGuard key, an OpenVPN login, root's password). */
const ownerOnly = (mode: string | undefined) => mode !== undefined && /0?[0-7]00$/.test(mode);

export const isSecretSource = (source: SecretSource | undefined) =>
  source !== undefined && ("option" in source ? isSecretOption(source.option) : ownerOnly(source.file.mode));

/** Replaces a value before it is printed; `source` says where it comes from, when known. */
export type Redact = (value: string, source?: SecretSource) => string;

export const redactedText = "<redacted>";

/**
 * Hides every secret: by its place (option or file) and, where a value came
 * from `{ "$secret": name }`, by the value itself (`byValue`), so one printed
 * anywhere else is caught too.
 */
export const redactor =
  (byValue: (value: string) => string = (value) => value): Redact =>
  (value, source) =>
    value.length > 0 && isSecretSource(source) ? redactedText : byValue(value);
