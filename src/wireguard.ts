// WireGuard keys, made where they are needed (the browser, for a client whose
// private key never leaves the page) and synchronously, so a setting's swap
// can make one: X25519 as RFC 7748 gives it, on BigInt, with no dependency.
// Not constant-time, which only matters for a key used where an attacker can
// time it; these are made once, on the user's own machine.

// Written without BigInt literals: the build targets an ECMAScript before them.
const [ZERO, ONE, TWO, EIGHT, MASK] = [0, 1, 2, 8, 255].map(BigInt);
const P = (ONE << BigInt(255)) - BigInt(19);
const A24 = BigInt(121665);
const mod = (a: bigint) => ((a % P) + P) % P;
const pow = (base: bigint, exponent: bigint) => {
  let result = ONE;
  let b = mod(base);
  for (let e = exponent; e > ZERO; e >>= ONE) {
    if (e & ONE) result = mod(result * b);
    b = mod(b * b);
  }
  return result;
};
const fromLE = (bytes: Uint8Array) => bytes.reduceRight((n, byte) => (n << EIGHT) + BigInt(byte), ZERO);
const toLE = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & MASK));

/** A private key as WireGuard keeps it: clamped (RFC 7748 §5). */
const clamp = (key: Uint8Array) => {
  const k = Uint8Array.from(key);
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;
  return k;
};

/** X25519(scalar, u): the Montgomery ladder of RFC 7748 §5. */
export const x25519 = (scalar: Uint8Array, u: Uint8Array) => {
  const k = fromLE(clamp(scalar));
  const point = Uint8Array.from(u);
  point[31] &= 127;
  const x1 = fromLE(point);
  let [x2, z2, x3, z3] = [ONE, ZERO, x1, ONE];
  let swap = ZERO;
  for (let t = 254; t >= 0; t--) {
    const bit = (k >> BigInt(t)) & ONE;
    if (swap ^ bit) [x2, x3, z2, z3] = [x3, x2, z3, z2];
    swap = bit;
    const a = mod(x2 + z2);
    const aa = mod(a * a);
    const b = mod(x2 - z2);
    const bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = mod(d * a);
    const cb = mod(c * b);
    const sum = mod(da + cb);
    const difference = mod(da - cb);
    x3 = mod(sum * sum);
    z3 = mod(x1 * mod(difference * difference));
    x2 = mod(aa * bb);
    z2 = mod(e * mod(aa + A24 * e));
  }
  if (swap) [x2, x3, z2, z3] = [x3, x2, z3, z2];
  return toLE(mod(x2 * pow(z2, P - TWO)));
};

const BASE = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 : 0));
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[n & 63] : "=";
  }
  return out;
};

export const fromBase64 = (text: string) => {
  const clean = text.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("not base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
};

/** A WireGuard key as `wg` prints it: 32 bytes, base64. */
export const wireguardKey = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;

/** The public key of a private one, as `wg pubkey` gives it. */
export const publicKeyOf = (privateKey: string) => toBase64(x25519(fromBase64(privateKey), BASE));

/** A new private key, as `wg genkey` makes one: random, clamped. */
export const newPrivateKey = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64(clamp(bytes));
};
