import test from "ava";
import { sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";
import { writeFileSync } from "fs";
import { join } from "path";
import { rpcdAuth } from "../../server/auth";
import { uiHandler } from "../../server/app";
import { nodePlatform } from "../../platforms/node";

test("a router whose root has no password refuses every login, as rpcd would take any", async (t) => {
  const dir = tempDir("auth-open");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText());
  const destroyed: string[] = [];
  let made = 0;
  // Stock 25.12: an empty root hash, so session login succeeds for anything.
  const run = async (argv: string[], options?: { stdin?: string }) => {
    if (argv[0] !== "ucode") return nodePlatform.run(argv, options);
    const { method, args } = JSON.parse(options?.stdin ?? "{}");
    const sid = (made++).toString(16).padStart(32, "0");
    if (method === "destroy") destroyed.push(args.ubus_rpc_session);
    const result = method === "login" ? { ubus_rpc_session: sid } : {};
    return { code: 0, stdout: JSON.stringify({ result, error: null }), stderr: "" };
  };
  const platform = { ...nodePlatform, run, sleep: async () => {} };
  const handle = uiHandler({ intentPath, uiRoot: dir, platform, auth: rpcdAuth(platform), loginAttemptsDir: join(dir, "attempts") });
  const response = await handle({
    method: "POST",
    path: "/api/login",
    body: JSON.stringify({ password: "anything" }),
    headers: { "x-onc": "1" },
  });
  t.is(response.status, 403);
  t.regex(JSON.parse(response.body).error, /no root password/);
  t.false("set-cookie" in response.headers);
  t.is(destroyed.length, 1, "the session the check made is ended");
});
