// A host key's fingerprint, as ssh-keygen -l and dropbear print it, so a
// person can compare it with the device's own console before trusting it.
import test from "ava";
import { createHash, randomBytes } from "crypto";
import { fingerprintOf, sha256Bytes } from "../../sshFingerprint";

test("SHA-256 of bytes matches Node's, across the padding boundaries", (t) => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const data = randomBytes(size);
    t.is(Buffer.from(sha256Bytes(new Uint8Array(data))).toString("hex"), createHash("sha256").update(data).digest("hex"), `${size} bytes`);
  }
});

test("a key's fingerprint is what ssh-keygen -l prints for it", (t) => {
  // A throwaway key, made for this test: `ssh-keygen -lf` printed the fingerprint below.
  const key = "AAAAC3NzaC1lZDI1NTE5AAAAID5Uksu7SVbBjJHbyYQi5Ph9ttJOj9q5YIlUqopPzPZH";
  t.is(fingerprintOf(key), "SHA256:gh/DjvamWtJ5GKvUg3A1h7FCtff7jQ+tzXzJM3F15R8");
});
