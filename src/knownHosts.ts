// Trust-on-first-use host keys, in OpenSSH's known_hosts format so that the
// Node platform (ssh2) and OpenSSH itself (the QuickJS platform) can share one
// file. Only plain entries are understood; hashed (`|1|`) and marker (`@`)
// lines are skipped, which is why OpenSSH is run with HashKnownHosts=no.

export type KnownHost = { host: string; type: string; key: string };

export const parseKnownHosts = (text: string): KnownHost[] =>
  text.split("\n").flatMap((line) => {
    const [hosts, type, key] = line.trim().split(/\s+/);
    if (!hosts || !type || !key || hosts.startsWith("#")) return [];
    if (hosts.startsWith("|") || hosts.startsWith("@")) return [];
    return hosts.split(",").map((host) => ({ host, type, key }));
  });

export const formatKnownHost = ({ host, type, key }: KnownHost) =>
  `${host} ${type} ${key}\n`;

/**
 * "changed" covers a different key of the same type and also a host that is
 * known only by other key types: accepting a new type for a known host would
 * let an impostor sidestep the check by offering a type we have not seen.
 */
export const checkHostKey = (
  entries: KnownHost[],
  candidate: KnownHost
): "known" | "new" | "changed" => {
  const forHost = entries.filter((entry) => entry.host === candidate.host);
  if (forHost.length === 0) return "new";
  return forHost.some(
    (entry) => entry.type === candidate.type && entry.key === candidate.key
  )
    ? "known"
    : "changed";
};

/** The key type named at the start of an SSH wire-format public key blob. */
export const keyTypeOfBlob = (blob: Uint8Array) => {
  const length =
    ((blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]) >>> 0;
  return String.fromCharCode(...Array.from(blob.subarray(4, 4 + length)));
};

/** Signature algorithms that can verify a key of the given stored type. */
export const hostKeyAlgorithms = (type: string) =>
  type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] : [type];

/** A key pinned in a device's facts (found by src/locate.ts) did not match. */
export const pinnedKeyChangedMessage = (host: string) =>
  `The SSH host key at ${host} is not the one on record for this device, so the connection was refused: ` +
  `it may be another machine. If the device was reflashed, remove it from Hardware and add it again.`;

export const hostKeyChangedMessage = (host: string, file: string) =>
  `The SSH host key for ${host} has changed, so the connection was refused: ` +
  `it may not be the device you think it is. If it was reflashed or its ` +
  `keys regenerated, delete its line from ${file} and connect again.`;
