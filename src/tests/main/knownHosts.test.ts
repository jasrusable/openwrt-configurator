import test from "ava";
import {
  checkHostKey,
  formatKnownHost,
  hostKeyAlgorithms,
  keyTypeOfBlob,
  parseKnownHosts,
} from "../../knownHosts";

const ed = { host: "10.0.0.1", type: "ssh-ed25519", key: "AAAAC3Nza-one" };

test("parses plain entries, skipping comments, hashed and marker lines", (t) => {
  const text = [
    "# comment",
    "10.0.0.1,router.lan ssh-ed25519 AAAAC3Nza-one a comment",
    "|1|salt=|hash= ssh-ed25519 AAAAhashed",
    "@cert-authority *.lan ssh-ed25519 AAAAca",
    "",
  ].join("\n");
  t.deepEqual(parseKnownHosts(text), [
    ed,
    { host: "router.lan", type: "ssh-ed25519", key: "AAAAC3Nza-one" },
  ]);
});

test("round-trips through formatKnownHost", (t) => {
  t.deepEqual(parseKnownHosts(formatKnownHost(ed)), [ed]);
});

test("new, known and changed", (t) => {
  t.is(checkHostKey([], ed), "new");
  t.is(checkHostKey([ed], ed), "known");
  t.is(checkHostKey([ed], { ...ed, key: "AAAAother" }), "changed");
  t.is(checkHostKey([ed], { ...ed, host: "10.0.0.2" }), "new");
});

test("a known host offering an unseen key type is treated as changed", (t) => {
  t.is(
    checkHostKey([ed], { ...ed, type: "ecdsa-sha2-nistp256", key: "AAAAe" }),
    "changed"
  );
});

test("reads the key type from a wire-format blob", (t) => {
  const type = "ssh-ed25519";
  const blob = new Uint8Array([
    0,
    0,
    0,
    type.length,
    ...Array.from(type, (c) => c.charCodeAt(0)),
    0,
    0,
    0,
    1,
    7,
  ]);
  t.is(keyTypeOfBlob(blob), type);
});

test("an RSA key may be verified by any RSA signature algorithm", (t) => {
  t.deepEqual(hostKeyAlgorithms("ssh-rsa"), [
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
  ]);
  t.deepEqual(hostKeyAlgorithms("ssh-ed25519"), ["ssh-ed25519"]);
});
