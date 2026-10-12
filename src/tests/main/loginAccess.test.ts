import test from "ava";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compileIntent } from "../../intent/compile";
import { Intent, intentSchema } from "../../intent/schema";
import { lockoutReason } from "../../loginAccess";
import { nodePlatform } from "../../platforms/node";

const root = join(__dirname, "..", "..", "..");
const sample = (): Intent =>
  intentSchema.parse(JSON.parse(readFileSync(join(root, "sampleConfigs", "intent.json"), "utf8")));
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA you@mac";
const other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB someone@else";

test("keys and password login compile to dropbear's authorized_keys and options", (t) => {
  const intent = sample();
  intent.admin = { ...intent.admin, authorized_keys: [key], password_login: false };
  const compiled = compileIntent(intent) as any;
  t.like(compiled.config.dropbear.dropbear[0], { PasswordAuth: "off", RootPasswordAuth: "off" });
  t.deepEqual(
    compiled.files.find((f: any) => f.path === "/etc/dropbear/authorized_keys"),
    { ".if": "*", path: "/etc/dropbear/authorized_keys", mode: "0600", content: `${key}\n` }
  );
  const none = compileIntent(sample()) as any;
  t.like(none.config.dropbear.dropbear[0], { PasswordAuth: "on" }, "the default: as before");
  t.false(none.files.some((f: any) => f.path === "/etc/dropbear/authorized_keys"), "no keys: a device's own file is left alone");
});

test("password login off needs a key; a key must look like one", (t) => {
  const issues = (admin: object) => {
    const r = intentSchema.safeParse({ ...JSON.parse(readFileSync(join(root, "sampleConfigs", "intent.json"), "utf8")), admin });
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };
  t.deepEqual(issues({ password_login: false }), ["admin.password_login"]);
  t.deepEqual(issues({ password_login: false, authorized_keys: [key] }), []);
  t.deepEqual(issues({ authorized_keys: ["not a key"] }), ["admin.authorized_keys.0"]);
});

test("an apply that would lock this app out is refused, and says why", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "onc-key-"));
  const keyPath = join(dir, "id_ed25519");
  writeFileSync(`${keyPath}.pub`, `${key}\n`);
  const intent = (admin: Partial<Intent["admin"]>) => ({ ...sample(), admin: { authorized_keys: [], password_login: true, ...admin } }) as Intent;
  t.is(await lockoutReason(intent({ ssh_key_path: keyPath }), nodePlatform), undefined, "password login on: nothing to lose");
  t.is(await lockoutReason(intent({ ssh_key_path: keyPath, password_login: false, authorized_keys: [key.replace("you@mac", "a different comment")] }), nodePlatform), undefined, "the comment does not matter");
  t.regex((await lockoutReason(intent({ ssh_key_path: keyPath, password_login: false, authorized_keys: [other] }), nodePlatform))!, /not among the authorized keys/);
  t.regex((await lockoutReason(intent({ password_login: false, authorized_keys: [other] }), nodePlatform))!, /no SSH key/);
});
