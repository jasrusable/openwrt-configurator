// The UI's saved-file version (ui/src/data/api.ts): a read of the settings
// answered after a save is of the file before it, so it is read again rather
// than setting the version (and the draft) back; and an apply names the
// version of the file its plan was made from.
import test from "ava";

Object.assign(globalThis, { location: { pathname: "/" } });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require("../../../ui/src/data/api") as typeof import("../../../ui/src/data/api");

type Sent = { url: string; method: string; headers: Record<string, string> };

/** A server holding one file: each GET answered when `release` is called, PUTs at once. */
const server = () => {
  let file = { system: { name: "v1" } };
  let version = "v1";
  const sent: Sent[] = [];
  const held: (() => void)[] = [];
  const answer = (body: unknown, v: string) => new Response(JSON.stringify(body), { status: 200, headers: { "x-onc-version": v } });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ url, method, headers: init.headers as Record<string, string> });
    if (method === "PUT") {
      file = JSON.parse(String(init.body));
      version = file.system.name;
      return answer(file, version);
    }
    if (url.startsWith("api/intent")) {
      // What the file is as the request arrives, answered later.
      const [body, v] = [file, version];
      return new Promise<Response>((resolve) => held.push(() => resolve(answer(body, v))));
    }
    return answer({}, version);
  }) as typeof fetch;
  const release = async () => {
    while (held.length) held.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { sent, release };
};

test("a read answered after a save is read again, never setting the version back", async (t) => {
  const { sent, release } = server();
  const first = api.loadIntent();
  await release();
  t.is((await first).system.name, "v1");

  const late = api.loadIntent();
  await api.saveIntent({ system: { name: "v2" } } as never);
  await release();
  await release();
  t.is((await late).system.name, "v2", "the read that crossed the save was made again");
  t.is(api.savedVersion(), "v2");

  await api.startProvision({ verify: { router: "h" }, version: "v2" });
  const start = sent.at(-1)!;
  t.is(start.url, "api/provision?version=v2");
  t.is(start.headers["x-onc-version"], "v2");
});
