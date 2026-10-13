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
import { redactSecretFields } from "../../secrets";
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
