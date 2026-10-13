// How the web API answers what is not a success: one status per kind of
// problem (src/server/router.ts), and every answer framed like any other,
// a thrown bug included. No test here reads a device.
import test from "ava";
import { writeFileSync } from "fs";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import { problem, ProblemKind } from "../../problem";
import { problemResponse } from "../../server/router";
import { uiHandler } from "../../server/app";
import { sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const request = (method: string, path: string, body = "") => ({ method, path, body, headers: { "x-onc": "1" } });

const withSample = () => {
  const dir = tempDir("api");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  return { dir, handle: uiHandler({ intentPath, uiRoot: dir, platform: nodePlatform }) };
};

test("each kind of problem has its status", (t) => {
  // A device or the network failing is the gateway's (502); a failure here is the server's (500).
  const statuses: Record<ProblemKind, number> = {
    invalid: 400,
    unauthorized: 401,
    forbidden: 403,
    "not-found": 404,
    unsupported: 405,
    "plan-stale": 409,
    conflict: 409,
    busy: 409,
    "rate-limited": 429,
    internal: 500,
    unreachable: 502,
    failed: 502,
  };
  for (const [kind, status] of Object.entries(statuses)) {
    const response = problemResponse(problem(kind as ProblemKind, "why", { details: { more: 1 } }));
    t.is(response.status, status, kind);
    t.deepEqual(JSON.parse(response.body), { error: "why", more: 1 });
  }
});

test("a save the schema refuses says so with its issues, as every error: { error, issues }", async (t) => {
  const { handle } = withSample();
  const response = await handle(request("PUT", "/api/intent", JSON.stringify({ schema: 1 })));
  t.is(response.status, 400);
  const body = JSON.parse(response.body);
  t.is(typeof body.error, "string");
  t.true(Array.isArray(body.issues) && body.issues.length > 0);
});

test("a missing X-ONC header is forbidden, and framed", async (t) => {
  const { handle } = withSample();
  const response = await handle({ method: "GET", path: "/api/intent", body: "", headers: {} });
  t.is(response.status, 403);
  t.is(JSON.parse(response.body).error, "Missing the X-ONC header.");
  t.is(response.headers["x-frame-options"], "DENY");
});

test("an unknown API path is 404 and a method a route lacks is 405, both framed", async (t) => {
  const { handle } = withSample();
  const missing = await handle(request("GET", "/api/nothing"));
  t.is(missing.status, 404);
  t.is(missing.headers["x-frame-options"], "DENY");
  const wrong = await handle(request("DELETE", "/api/status"));
  t.is(wrong.status, 405);
  t.regex(JSON.parse(wrong.body).error, /GET/);
});

test("a bug that throws is a framed JSON 500, never a dropped answer", async (t) => {
  const { dir } = withSample();
  const throwing = {
    ...nodePlatform,
    writeFileAtomic: () => {
      throw new TypeError("a bug");
    },
  };
  const handle = uiHandler({ intentPath: join(dir, "intent.json"), uiRoot: dir, platform: throwing });
  const response = await handle(request("PUT", "/api/intent", sampleIntentText()));
  t.is(response.status, 500);
  t.deepEqual(JSON.parse(response.body), { error: "a bug" });
  t.is(response.headers["content-security-policy"], "frame-ancestors 'none'");
});

test("adding hardware says what is wrong, with its status", async (t) => {
  const { handle } = withSample();
  const post = (path: string, body: object) => handle(request("POST", path, JSON.stringify(body)));
  t.is((await post("/api/discover/inspect", { address: "not an address!" })).status, 400);
  t.is((await post("/api/discover/adopt", { address: "10.254.0.66", name: "Not A Name" })).status, 400);
  const unread = await post("/api/discover/adopt", { address: "10.254.0.66", name: "ap-9" });
  t.is(unread.status, 409);
  t.regex(JSON.parse(unread.body).error, /Read the device first/);
  t.is((await handle(request("POST", "/api/discover/inspect", "[]"))).status, 400, "a body that is not an object");
  const noSettings = uiHandler({ intentPath: join(tempDir("api"), "missing.json"), uiRoot: "/", platform: nodePlatform });
  const none = await noSettings(request("GET", "/api/discover"));
  t.is(none.status, 404);
  t.regex(JSON.parse(none.body).error, /No settings are saved/);
});
