import test from "ava";
import { sampleIntent, sampleIntentJson } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";
import { writeFileSync } from "fs";
import { join } from "path";
import { compileIntent } from "../../intent/compile";
import { Intent, intentSchema } from "../../intent/schema";
import { lockoutReason } from "../../loginAccess";
import { nodePlatform } from "../../platforms/node";

const sample = (): Intent =>
  sampleIntent();
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA you@mac";
const other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB someone@else";

test("keys and password login compile to dropbear's authorized_keys and options", (t) => {
  const intent = sample();
  intent.system = { ...intent.system, ssh: { authorized_keys: [key], password_login: false } };
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
  const issues = (ssh: object) => {
    const sample = sampleIntentJson();
    const r = intentSchema.safeParse({ ...sample, system: { ...sample.system, ssh } });
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };
  t.deepEqual(issues({ password_login: false }), ["system.ssh.password_login"]);
  t.deepEqual(issues({ password_login: false, authorized_keys: [key] }), []);
  t.deepEqual(issues({ authorized_keys: ["not a key"] }), ["system.ssh.authorized_keys.0"]);
});

test("an apply that would lock this app out is refused, and says why", async (t) => {
  const dir = tempDir("key");
  const keyPath = join(dir, "id_ed25519");
  writeFileSync(`${keyPath}.pub`, `${key}\n`);
  // A key (this app's login) and the login rules, as one flat set for the cases below.
  const intent = ({ ssh_key_path, password, ...ssh }: { ssh_key_path?: string; password?: string; authorized_keys?: string[]; password_login?: boolean }) => {
    const s = sample();
    return {
      ...s,
      system: { ...s.system, app_login: { key: ssh_key_path, password }, ssh: { authorized_keys: [], password_login: true, ...ssh } },
    } as Intent;
  };
  t.is(await lockoutReason(intent({ ssh_key_path: keyPath }), nodePlatform), undefined, "password login on: nothing to lose");
  t.is(await lockoutReason(intent({ ssh_key_path: keyPath, password_login: false, authorized_keys: [key.replace("you@mac", "a different comment")] }), nodePlatform), undefined, "the comment does not matter");
  t.regex((await lockoutReason(intent({ ssh_key_path: keyPath, password_login: false, authorized_keys: [other] }), nodePlatform))!, /not among the authorized keys/);
  t.regex((await lockoutReason(intent({ password_login: false, authorized_keys: [other] }), nodePlatform))!, /no SSH key/);
  t.regex(
    (await lockoutReason(intent({ ssh_key_path: keyPath, authorized_keys: [other] }), nodePlatform))!,
    /no password to log in with, and this app's key is not among/,
    "password login on is no way in without a password to send"
  );
  t.is(await lockoutReason(intent({ password: "pw", authorized_keys: [other] }), nodePlatform), undefined);
});
