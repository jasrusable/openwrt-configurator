import test from "ava";
import { tempDir } from "../helpers/tempDir";
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveSecrets, secretsFileSource } from "../../resolveSecrets";
import { nodePlatform } from "../../platforms/node";

const secretsFile = (content: string, mode = 0o600) => {
  const dir = tempDir("secrets");
  const path = join(dir, "secrets.json");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

test("resolves refs from a 0600 file", async (t) => {
  const source = secretsFileSource({
    path: secretsFile('{"wifi/home": "pw-123"}'),
    platform: nodePlatform,
  });
  const { value } = await resolveSecrets(
    { key: { $secret: "wifi/home" } },
    source.lookup,
    source.describeMissing
  );
  t.deepEqual(value, { key: "pw-123" });
});

test("missing names are listed with the file's own hint", async (t) => {
  const path = secretsFile("{}");
  const source = secretsFileSource({ path: path, platform: nodePlatform });
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
  const source = secretsFileSource({
    path: "/nonexistent/onc/secrets.json",
    platform: nodePlatform,
  });
  t.is(await source.lookup("x"), undefined);
});

test("a file readable by others is refused", async (t) => {
  const source = secretsFileSource({
    path: secretsFile('{"x": "y"}', 0o644),
    platform: nodePlatform,
  });
  await t.throwsAsync(source.lookup("x"), { message: /chmod 600/ });
});

test("invalid JSON is reported without echoing the file", async (t) => {
  const source = secretsFileSource({
    path: secretsFile('{"x": "hunter2",}'),
    platform: nodePlatform,
  });
  const error = await t.throwsAsync(source.lookup("x"));
  t.false(error!.message.includes("hunter2"));
  t.regex(error!.message, /is not valid JSON/);
});

test("non-string values are rejected", async (t) => {
  const source = secretsFileSource({
    path: secretsFile('{"x": 5}'),
    platform: nodePlatform,
  });
  await t.throwsAsync(source.lookup("x"), { message: /must be a string/ });
});
