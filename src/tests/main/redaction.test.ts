import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { readFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getDeviceScript } from "../../getDeviceScript";
import { getOpenWrtState } from "../../engine/getOpenWrtState";
import { availability } from "../../intent/choices";
import { printPlan } from "../../lowLevel/print";
import { compileIntent } from "../../intent/compile";
import { intentSchema } from "../../intent/schema";
import { findPlaintextSecrets, redactSecretFields } from "../../secrets";
import { getUciCommands } from "../../engine/getUciCommands";
import { redactor } from "../../secretOptions";

const root = join(__dirname, "../../..");

// Every kind of secret an intent holds, inline (an intent has no $secret refs).
const secretIntent = () => {
  const sample = sampleIntent();
  const withVpn = availability(sample, "vpn.remote_access.enabled").option(true).swap!.apply(sample);
  const [line, ...rest] = withVpn.internet.lines;
  return intentSchema.parse({
    ...withVpn,
    system: { ...withVpn.system, app_login: { ...withVpn.system.app_login, password: "root-pass-SECRET" } },
    internet: {
      ...withVpn.internet,
      lines: [{ ...line, type: "pppoe", pppoe: { username: "ppp-user-SECRET", password: "ppp-pass-SECRET" } }, ...rest],
      dynamic_dns: { provider: "duckdns", hostname: "home.duckdns.org", token: "ddns-token-SECRET" },
    },
  });
};

const secretsOf = (intent: ReturnType<typeof secretIntent>) => [
  "root-pass-SECRET",
  "ppp-user-SECRET",
  "ppp-pass-SECRET",
  "ddns-token-SECRET",
  intent.vpn.remote_access.private_key!,
  ...intent.wifi.networks.flatMap((w) => [w.password, ...(w.extra_passwords ?? [])]).filter((p): p is string => !!p),
];

test("compile's output hides every secret an intent holds, by option and by owner-only file", (t) => {
  const intent = secretIntent();
  // As `compile` prints it: the plan as low-level JSON.
  const printed = JSON.stringify(redactSecretFields(printPlan(compileIntent(intent))));
  for (const secret of secretsOf(intent)) t.false(printed.includes(secret), `${secret.slice(0, 4)}… printed`);
});

test("the dry run of an intent hides every secret, though none came from the keychain", (t) => {
  const intent = secretIntent();
  const plan = compileIntent(intent);
  const deviceSchema = deviceSchemaSchema.parse(
    JSON.parse(readFileSync(join(root, "deviceSchemas", "friendlyarm,nanopi-r6s.json"), "utf8"))
  );
  const deviceConfig = { ...plan.devices.find((d) => d.hostname === "home-router")!, model_id: "friendlyarm,nanopi-r6s" };
  const state = getOpenWrtState({ plan, deviceConfig, deviceSchema });
  const script = getDeviceScript({ state, redact: redactor() }).join("\n");
  for (const secret of secretsOf(intent)) t.false(script.includes(secret), `${secret.slice(0, 4)}… printed`);
  t.regex(script, /<redacted>/);
  t.true(getDeviceScript({ state }).join("\n").includes("root-pass-SECRET"), "and they are there unredacted");
});

test("a secret is one by its option whatever its type: a numeric password is hidden, a flag or number elsewhere is not", (t) => {
  const commands = getUciCommands({
    openWrtConfig: { network: { interface: [{ ".name": "wan", password: 12345678, metric: 10, auto: true }] } },
    redact: redactor((value) => (value === "1" || value === "10" ? "<by value>" : value)),
  }).join("\n");
  t.false(commands.includes("12345678"));
  t.true(commands.includes("uci set network.wan.password='<redacted>'"));
  t.true(commands.includes("uci set network.wan.metric='10'"), "only an original string is matched by value");
  t.true(commands.includes("uci set network.wan.auto='1'"));
  t.deepEqual(redactSecretFields({ password: 12345678, metric: 10 }), { password: "<redacted>", metric: 10 });
  t.deepEqual(findPlaintextSecrets({ wan: { password: 12345678 } }), ["wan.password"]);
});
