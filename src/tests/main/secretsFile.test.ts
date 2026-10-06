import test from "ava";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveSecrets, secretsFileSource } from "../../resolveSecrets";

const secretsFile = (content: string, mode = 0o600) => {
  const path = join(
    mkdtempSync(join(tmpdir(), "onc-secrets-")),
    "secrets.json"
  );
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

test("resolves refs from a 0600 file", async (t) => {
  const source = secretsFileSource(secretsFile('{"wifi/home": "pw-123"}'));
  const { value } = await resolveSecrets(
    { key: { $secret: "wifi/home" } },
    source.lookup,
    source.describeMissing
  );
  t.deepEqual(value, { key: "pw-123" });
});

test("missing names are listed with the file's own hint", async (t) => {
  const path = secretsFile("{}");
  const source = secretsFileSource(path);
  const error = await t.throwsAsync(
    resolveSecrets(
      { a: { $secret: "x" } },
      source.lookup,
      source.describeMissing
    )
  );
  t.true(error!.message.startsWith(`Missing secrets in ${path}:\n  - x`));
});

test("an absent file means every secret is missing, not an error", async (t) => {
  const source = secretsFileSource("/nonexistent/onc/secrets.json");
  t.is(await source.lookup("x"), undefined);
});

test("a file readable by others is refused", async (t) => {
  const source = secretsFileSource(secretsFile('{"x": "y"}', 0o644));
  await t.throwsAsync(source.lookup("x"), { message: /chmod 600/ });
});

test("invalid JSON is reported without echoing the file", async (t) => {
  const source = secretsFileSource(secretsFile('{"x": "hunter2",}'));
  const error = await t.throwsAsync(source.lookup("x"));
  t.false(error!.message.includes("hunter2"));
  t.regex(error!.message, /is not valid JSON/);
});

test("non-string values are rejected", async (t) => {
  const source = secretsFileSource(secretsFile('{"x": 5}'));
  await t.throwsAsync(source.lookup("x"), { message: /must be a string/ });
});
