import test from "ava";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFacts } from "../../deviceFacts";
import { nodePlatform } from "../../platforms/node";
import { rpcdAuth } from "../../server/auth";
import { uiHandler } from "../../server/handlers";

const root = join(__dirname, "../../..");

const withServer = async (
  run: (handle: ReturnType<typeof uiHandler>, intentPath: string) => Promise<void>
) => {
  const dir = mkdtempSync(join(tmpdir(), "onc-server-"));
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, readFileSync(join(root, "sampleConfigs/intent.json")));
  try {
    await run(uiHandler({ intentPath, uiRoot: dir, platform: nodePlatform }), intentPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const request = (method: string, path: string, body = "", headers: Record<string, string> = { "x-onc": "1" }) => ({
  method,
  path,
  body,
  headers,
});

test("an API request without the X-ONC header is refused (CSRF), reads too", async (t) => {
  await withServer(async (handle, intentPath) => {
    const before = readFileSync(intentPath, "utf8");
    const intent = JSON.parse(before);
    const put = await handle(request("PUT", "/api/intent", JSON.stringify(intent), {}));
    t.is(put.status, 403);
    const post = await handle(request("POST", "/api/provision", "", {}));
    t.is(post.status, 403);
    // A GET that would log in to the devices, as an <img> on any page could ask.
    t.is((await handle(request("GET", "/api/status", "", {}))).status, 403);
    t.is(readFileSync(intentPath, "utf8"), before);
  });
});

test("a valid save is written whole, readable only by its owner", async (t) => {
  await withServer(async (handle, intentPath) => {
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    intent.site.name = "Cabin";
    const put = await handle(
      request("PUT", "/api/intent", JSON.stringify(intent), { "x-onc": "1" })
    );
    t.is(put.status, 200);
    t.is(JSON.parse(readFileSync(intentPath, "utf8")).site.name, "Cabin");
    t.is(statSync(intentPath).mode & 0o777, 0o600);
  });
});

test("an invalid save is refused with the fields to fix", async (t) => {
  await withServer(async (handle, intentPath) => {
    const before = readFileSync(intentPath, "utf8");
    const intent = JSON.parse(before);
    intent.wifi[0].password = "short";
    const put = await handle(
      request("PUT", "/api/intent", JSON.stringify(intent), { "x-onc": "1" })
    );
    t.is(put.status, 400);
    t.deepEqual(JSON.parse(put.body).issues, [
      { path: "wifi.0.password", message: "at least 8 characters" },
    ]);
    t.is(readFileSync(intentPath, "utf8"), before);
  });
});

test("an invalid saved draft is never provisioned", async (t) => {
  await withServer(async (handle, intentPath) => {
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    intent.site.country = "XX";
    writeFileSync(intentPath, JSON.stringify(intent));
    const post = await handle(request("POST", "/api/provision", "", { "x-onc": "1" }));
    t.is(post.status, 409);
    t.regex(JSON.parse(post.body).error, /not valid/);
  });
});

test("settings a file leaves out are served as their defaults", async (t) => {
  await withServer(async (handle, intentPath) => {
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    delete intent.radios;
    writeFileSync(intentPath, JSON.stringify(intent));
    const served = JSON.parse((await handle(request("GET", "/api/intent"))).body);
    t.deepEqual(served.radios["6g"], {
      enabled: false,
      width: "auto",
      power: "auto",
      cell_density: "normal",
      airtime: "balanced",
    });
  });
});

test("adopting under a name already in Hardware is refused: it would re-pin that device's host key", async (t) => {
  await withServer(async (handle, intentPath) => {
    const existing = JSON.parse(readFileSync(intentPath, "utf8")).hardware[0].name;
    const post = await handle(
      request("POST", "/api/discover/adopt", JSON.stringify({ address: "10.0.0.66", name: existing }), { "x-onc": "1" })
    );
    t.is(post.status, 409);
    t.regex(JSON.parse(post.body).error, /already in Hardware/);
  });
});

test("adopting a box already in Hardware under another name is refused: its key is on record", async (t) => {
  await withServer(async (handle, intentPath) => {
    const existing = JSON.parse(readFileSync(intentPath, "utf8")).hardware[1].name;
    const schema = { name: "zyxel,nwa50ax-pro", version: "25.12.5", ports: [{ name: "lan1", default_role: "lan" as const }] };
    const hostKey = { type: "ssh-ed25519", key: "SAME-KEY" };
    writeFacts(nodePlatform, intentPath, { hostname: existing, readAt: 1, schema, hostKey, macs: ["aa:bb:cc:00:00:01"] });
    writeFileSync(
      `${intentPath}.state/devices/inspected-10.0.0.66.json`,
      JSON.stringify({ address: "10.0.0.66", schema, macs: [], hostname: "OpenWrt", hostKey, openLogin: false, suggested: { name: "ap-2", role: "access-point" } })
    );
    const post = await handle(request("POST", "/api/discover/adopt", JSON.stringify({ address: "10.0.0.66", name: "ap-9" })));
    t.is(post.status, 409);
    t.regex(JSON.parse(post.body).error, new RegExp(`This is ${existing}`));
  });
});

test("on a router, the API needs a session from the root password; the UI's files do not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "onc-auth-"));
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, readFileSync(join(__dirname, "../../../sampleConfigs/intent.json")));
  const sid = "0123456789abcdef0123456789abcdef";
  const other = "fedcba9876543210fedcba9876543210";
  const calls: unknown[] = [];
  // rpcd through ucode's ubus module, as on 25.12.5: the request on stdin.
  const run = async (argv: string[], options?: { stdin?: string }) => {
    if (argv[0] !== "ucode") return nodePlatform.run(argv, options);
    calls.push({ argv, stdin: options?.stdin });
    const { method, args } = JSON.parse(options?.stdin ?? "{}");
    const result =
      method === "login"
        ? args.password === "right" ? { ubus_rpc_session: sid } : null
        : method === "access"
          ? [sid, other].includes(args.ubus_rpc_session) ? { access: true } : null
          : method === "list"
            ? args.ubus_rpc_session === sid ? { data: { username: "root" } } : args.ubus_rpc_session === other ? { data: { username: "luci-user" } } : null
            : {};
    return { code: 0, stdout: JSON.stringify({ result, error: result ? null : "Not found" }), stderr: "" };
  };
  const platform = { ...nodePlatform, run, sleep: async () => {} };
  const handle = uiHandler({ intentPath, uiRoot: dir, platform, auth: rpcdAuth(platform) });
  const api = (method: string, path: string, body = "", cookie = "") =>
    handle({ method, path, body, headers: { "x-onc": "1", ...(cookie ? { cookie } : {}) } });
  t.is((await api("GET", "/api/intent")).status, 401);
  const wrong = await api("POST", "/api/login", JSON.stringify({ password: "nope" }));
  t.is(wrong.status, 401);
  t.false("set-cookie" in wrong.headers);
  const right = await api("POST", "/api/login", JSON.stringify({ password: "right" }));
  t.regex(right.headers["set-cookie"], new RegExp(`^onc_session=${sid}; Path=/; HttpOnly; SameSite=Strict$`));
  t.is((await api("GET", "/api/intent", "", `onc_session=${sid}`)).status, 200);
  t.is((await api("GET", "/api/intent", "", "onc_session=ffffffffffffffffffffffffffffffff")).status, 401);
  t.is((await api("GET", "/api/intent", "", `onc_session=${other}`)).status, 401, "another user's session, though it may write");
  t.false(calls.some((c: any) => c.argv.join(" ").includes("right")), "the password never on a command line");
  t.regex((await api("POST", "/api/logout", "", `onc_session=${sid}`)).headers["set-cookie"] ?? "", /Max-Age=0/);
});

test("wrong passwords sent side by side are counted together: after five in a minute, logins pause", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "onc-auth-"));
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, readFileSync(join(__dirname, "../../../sampleConfigs/intent.json")));
  const run = async (argv: string[], options?: { stdin?: string }) =>
    argv[0] === "ucode" ? { code: 0, stdout: JSON.stringify({ result: null }), stderr: "" } : nodePlatform.run(argv, options);
  const platform = { ...nodePlatform, run, sleep: async () => {} };
  const handle = uiHandler({ intentPath, uiRoot: dir, platform, auth: rpcdAuth(platform) });
  const guess = () => handle({ method: "POST", path: "/api/login", body: JSON.stringify({ password: "nope" }), headers: { "x-onc": "1" } });
  const statuses = (await Promise.all([1, 2, 3, 4, 5, 6, 7].map(guess))).map((r) => r.status);
  t.true(statuses.includes(429), JSON.stringify(statuses));
  t.is((await guess()).status, 429, "and the next too, until the minute passes");
  // Counted per client: another one on the network is not paused by it.
  const other = await handle({ method: "POST", path: "/api/login", body: JSON.stringify({ password: "nope" }), headers: { "x-onc": "1" }, remoteAddress: "10.0.0.77" });
  t.is(other.status, 401);
});

test("renaming a device keeps what is known of it, its pinned host key above all", async (t) => {
  await withServer(async (handle, intentPath) => {
    const { readFacts } = require("../../deviceFacts");
    writeFacts(nodePlatform, intentPath, {
      hostname: "home-ap-1",
      readAt: 1,
      schema: { name: "ap", version: "25.12.5" },
      address: "10.0.0.5",
      hostKey: { type: "ssh-ed25519", key: "AAAA" },
    } as any);
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    intent.hardware[1].name = "hall-ap";
    t.is((await handle(request("PUT", "/api/intent", JSON.stringify(intent)))).status, 200);
    const facts = readFacts(nodePlatform, intentPath, ["home-ap-1", "hall-ap"]);
    t.is(facts["home-ap-1"], undefined);
    t.like(facts["hall-ap"], { hostname: "hall-ap", address: "10.0.0.5", hostKey: { key: "AAAA" } });
  });
});

test("a save or an apply of a version older than the file is refused: another tab's save is never undone", async (t) => {
  await withServer(async (handle, intentPath) => {
    const read = await handle(request("GET", "/api/intent"));
    const version = read.headers["x-onc-version"];
    t.truthy(version);
    const mine = JSON.parse(read.body);
    // Another tab saves first.
    const theirs = { ...mine, site: { ...mine.site, name: "Theirs" } };
    const saved = await handle(request("PUT", "/api/intent", JSON.stringify(theirs), { "x-onc": "1", "x-onc-version": version }));
    t.is(saved.status, 200);
    t.not(saved.headers["x-onc-version"], version);
    // This one, still on the old version, is refused, and nothing is overwritten.
    const stale = await handle(request("PUT", "/api/intent", JSON.stringify({ ...mine, site: { ...mine.site, name: "Mine" } }), { "x-onc": "1", "x-onc-version": version }));
    t.is(stale.status, 409);
    t.true(JSON.parse(stale.body).changedElsewhere);
    t.is(JSON.parse(readFileSync(intentPath, "utf8")).site.name, "Theirs");
    t.is((await handle(request("POST", "/api/provision", "", { "x-onc": "1", "x-onc-version": version }))).status, 409);
  });
});

test("no page can frame the app: every answer says so", async (t) => {
  await withServer(async (handle) => {
    for (const r of [await handle(request("GET", "/")), await handle(request("GET", "/api/intent"))]) {
      t.is(r.headers["x-frame-options"], "DENY");
      t.is(r.headers["content-security-policy"], "frame-ancestors 'none'");
    }
  });
});
