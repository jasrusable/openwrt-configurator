import test from "ava";
import { fromBase64, newPrivateKey, publicKeyOf, toBase64, wireguardKey, x25519 } from "../../wireguard";

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("X25519 as RFC 7748 §6.1 gives it: each side's public key, and the shared secret", (t) => {
  const alice = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const bob = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const base = hex("0900000000000000000000000000000000000000000000000000000000000000");
  const alicePub = x25519(alice, base);
  const bobPub = x25519(bob, base);
  t.is(toHex(alicePub), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  t.is(toHex(bobPub), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  t.is(toHex(x25519(alice, bobPub)), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
  t.is(toHex(x25519(bob, alicePub)), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
});

test("WireGuard keys: made like wg genkey, public as wg pubkey, the same as WebCrypto's X25519", async (t) => {
  const priv = newPrivateKey();
  t.regex(priv, wireguardKey);
  t.regex(publicKeyOf(priv), wireguardKey);
  t.is(toBase64(fromBase64(priv)), priv);
  // Node's own X25519, as a second opinion: a private key's public half.
  const pkcs8 = Uint8Array.from([...Buffer.from("302e020100300506032b656e04220420", "hex"), ...fromBase64(priv)]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  t.is(Buffer.from(jwk.x!, "base64url").toString("base64"), publicKeyOf(priv));
});
