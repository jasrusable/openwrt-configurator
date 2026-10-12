// The web UI's backend: one handler for the API and the UI's static files.
// Transport-free, so the Node server (`ui`) and CGI under uhttpd on a router
// (`cgi`) answer every request with the same code. The UI uses relative URLs,
// so it works wherever it is mounted: / on a Mac, /cgi-bin/onc/ on a router.
import { Auth, sessionSetCookie } from "./auth";
import { readApplyDiff } from "../applyDiff";
import { measureLink } from "../meshSpeed";
import { adopt, discover, Inspected, inspect } from "../discover";
import { readFacts, readFailures, refreshStale, staleDevices } from "../deviceFacts";
import { compileIntent } from "../intent/compile";
import { lockoutReason, ownPublicKey } from "../loginAccess";
import { readNetworkStatus, StatusView, statusViews } from "../status/read";
import { latestRelease, restartService, speedTest } from "../status/actions";
import { diffIntent } from "../intent/diff";
import { migrateIntent } from "../intent/migrations";
import { intentSchema } from "../intent/schema";
import { oncConfigSchema } from "../oncConfigSchema";
import { parseConfigJson } from "../parseJson";
import { HttpHandler, HttpResponse, Platform } from "../platform";
import { jobPaths, provisionStatus, startProvision } from "./provisionJob";

type Files = Pick<Platform, "readTextFile" | "writeFileAtomic">;

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

const issues = (error: { issues: { path: (string | number)[]; message: string }[] }) =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

/** GET and PUT the intent file. */
export const intentApi =
  ({ intentPath, files }: { intentPath: string; files: Files }): HttpHandler =>
  async ({ method, body }) => {
    if (method === "GET") {
      try {
        // In the current format, the only one the UI knows, and with the
        // schema's defaults filled in: a setting a file leaves out must show
        // as its default, or saving would write whatever the control showed.
        // An invalid file comes back as written, for the UI to flag.
        const intent = migrateIntent(
          parseConfigJson(files.readTextFile(intentPath), intentPath)
        );
        const parsed = intentSchema.safeParse(intent);
        return json(200, parsed.success ? parsed.data : intent);
      } catch (e) {
        return json(404, { error: (e as Error).message });
      }
    }
    if (method === "PUT") {
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        return json(400, { error: "The body is not JSON." });
      }
      const intent = intentSchema.safeParse(input);
      if (!intent.success) return json(400, { issues: issues(intent.error) });
      // Never save what would not provision: a compiler bug shows up here,
      // not halfway through a run.
      const compiled = oncConfigSchema.safeParse(compileIntent(intent.data));
      if (!compiled.success) {
        return json(500, {
          error: "The intent is valid but did not compile.",
          issues: issues(compiled.error),
        });
      }
      // The file holds passwords: only its owner may read it.
      files.writeFileAtomic(
        intentPath,
        JSON.stringify(intent.data, null, 2) + "\n",
        0o600
      );
      return json(200, intent.data);
    }
    return json(405, { error: `${method} is not supported.` });
  };

const notFound: HttpResponse = { status: 404, headers: {}, body: "Not found" };

const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
};

/** The built UI (text files only), from a directory. */
export const staticFiles =
  ({ root, files }: { root: string; files: Pick<Platform, "readTextFile"> }): HttpHandler =>
  async ({ path }): Promise<HttpResponse> => {
    const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    if (relative.split("/").some((part) => part === ".." || part === "")) {
      return notFound;
    }
    const extension = relative.split(".").pop() ?? "";
    try {
      return {
        status: 200,
        headers: {
          "content-type": contentTypes[extension] ?? "application/octet-stream",
          // Revalidate every time: file names do not change between builds.
          "cache-control": "no-cache",
        },
        body: files.readTextFile(`${root}/${relative}`),
      };
    } catch {
      return notFound;
    }
  };

type JobPlatform = Files & Pick<Platform, "run" | "selfCommand" | "homedir">;

/**
 * An intent file, in the current format and with defaults filled in when it
 * is valid (so a diff never reports a default as a change); undefined if
 * missing or unreadable.
 */
const readIntent = (files: Files, path: string) => {
  try {
    const intent = migrateIntent(parseConfigJson(files.readTextFile(path), path));
    const parsed = intentSchema.safeParse(intent);
    return (parsed.success ? parsed.data : intent) as any;
  } catch {
    return undefined;
  }
};

/**
 * GET: whether a provision is running, its log, and what the draft changes
 * compared with what was last provisioned. POST: provision the saved draft.
 */
export const provisionApi =
  ({
    intentPath,
    platform,
  }: {
    intentPath: string;
    platform: JobPlatform;
  }): HttpHandler =>
  async ({ method }) => {
    if (method === "GET") {
      const status = await provisionStatus({ intentPath, files: platform });
      const draft = readIntent(platform, intentPath);
      const live = readIntent(platform, jobPaths(intentPath).live);
      return json(200, {
        ...status,
        devices: ((draft?.hardware as { name: string }[]) || []).map((d) => d.name),
        // Never provisioned from here: everything is new, so no diff.
        changes: live ? diffIntent(live, draft) : [],
      });
    }
    if (method === "POST") {
      // Never provision what would not have been saved: a file edited by
      // hand, or saved under older rules, is refused here, not mid-run.
      const draft = intentSchema.safeParse(readIntent(platform, intentPath));
      const compiled =
        draft.success && oncConfigSchema.safeParse(compileIntent(draft.data));
      if (!draft.success || !compiled || !compiled.success) {
        return json(409, {
          error: "The saved settings are not valid: fix them, save, then apply.",
        });
      }
      // Said now, not minutes later in the log (the run refuses it too).
      const lockout = await lockoutReason(draft.data, platform);
      if (lockout) return json(409, { error: lockout });
      const result = await startProvision({
        intentPath,
        files: platform,
        now: () => Date.now(),
      });
      return result.started
        ? json(202, { started: true })
        : json(409, { error: result.reason });
    }
    return json(405, { error: `${method} is not supported.` });
  };

/** Everything the UI needs, behind any transport. */
/** The saved intent's device names, and the low-level config it compiles to, if it does. */
const compiled = (files: Files, path: string) => {
  const parsed = intentSchema.safeParse(readIntent(files, path));
  if (!parsed.success) return undefined;
  const config = oncConfigSchema.safeParse(compileIntent(parsed.data));
  return config.success ? { intent: parsed.data, config: config.data } : undefined;
};

/**
 * GET: what each device is, as last read, which last read failed, and which
 * are stale. POST: read the stale ones now (read-only), which a page that
 * shows facts asks for as it opens; then the same as GET.
 */
export const devicesApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method }) => {
    const answer = () => {
      const names = ((readIntent(platform, intentPath)?.hardware as { name: string }[]) ?? []).map((d) => d.name);
      const facts = readFacts(platform, intentPath, names);
      const failures = readFailures(platform, intentPath, names);
      return json(200, { facts, failures, stale: staleDevices({ facts, failures, now: Date.now() }) });
    };
    if (method === "GET") return answer();
    if (method === "POST") {
      await refreshStale({ intentPath, platform });
      return answer();
    }
    return json(405, { error: "GET or POST" });
  };

const addressPattern = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const inspectedFile = (intentPath: string, address: string) => `${intentPath}.state/devices/inspected-${address.replace(/[^A-Za-z0-9.-]/g, "_")}.json`;

/**
 * Add hardware, guided (src/discover.ts). GET /api/discover: what is on the
 * network and not in Hardware. POST /api/discover/inspect {address}: read
 * that device (read-only), kept here so adopting uses this read and nothing
 * the browser sends. POST /api/discover/adopt {address, name}: keep its
 * facts under that name.
 */
export const discoverApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method, path, body }) => {
    if (method === "GET" && path === "/api/discover") return json(200, await discover({ intentPath, platform }));
    if (method !== "POST") return json(405, { error: "GET or POST" });
    let input: { address?: unknown; name?: unknown };
    try {
      input = JSON.parse(body || "{}");
    } catch {
      return json(400, { error: "The body is not JSON." });
    }
    const address = typeof input.address === "string" ? input.address.trim() : "";
    if (!addressPattern.test(address)) return json(400, { error: "Give an address, like 10.0.0.143 or ap.lan." });
    if (path === "/api/discover/inspect") {
      const intent = intentSchema.safeParse(readIntent(platform, intentPath));
      if (!intent.success) return json(409, { error: "The saved settings are not valid." });
      try {
        const inspected = await inspect({ address, intent: intent.data, platform });
        platform.mkdirp(`${intentPath}.state/devices`);
        platform.writeTextFile(inspectedFile(intentPath, address), JSON.stringify(inspected));
        return json(200, inspected);
      } catch (e) {
        return json(502, { error: (e as Error).message });
      }
    }
    if (path === "/api/discover/adopt") {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return json(400, { error: "A name like ap-2." });
      // Adopting writes the facts locating trusts (address, host key): under a
      // name already in Hardware it would re-pin that device to this one.
      const saved = intentSchema.safeParse(readIntent(platform, intentPath));
      if (!saved.success) return json(409, { error: "The saved settings are not valid." });
      if (saved.data.hardware.some((d) => d.name === name)) return json(409, { error: `${name} is already in Hardware.` });
      let inspected: Inspected;
      try {
        inspected = JSON.parse(platform.readTextFile(inspectedFile(intentPath, address)));
      } catch {
        return json(409, { error: "Read the device first." });
      }
      // Nor the same box twice, under another name: its key or a MAC already belongs to one.
      const known = readFacts(platform, intentPath, saved.data.hardware.map((d) => d.name));
      const same = Object.values(known).find(
        (f) =>
          f &&
          ((inspected.hostKey && f.hostKey?.key === inspected.hostKey.key) ||
            (f.macs ?? []).some((mac) => inspected.macs.includes(mac)))
      );
      if (same) return json(409, { error: `This is ${same.hostname}, already in Hardware.` });
      adopt(platform, intentPath, name, inspected, Date.now());
      return json(200, { ok: true });
    }
    return json(404, { error: "Not found." });
  };

/** GET: this app's own public key (beside its saved SSH key), so the UI can offer to authorize it. */
export const ownKeyApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method }) => {
    if (method !== "GET") return json(405, { error: "GET" });
    const keyPath = readIntent(platform, intentPath)?.admin?.ssh_key_path as string | undefined;
    const publicKey = keyPath ? await ownPublicKey(platform, keyPath) : undefined;
    return json(200, { publicKey: publicKey ?? null });
  };

/** GET: what the network is doing now, read from the devices (src/status/). Polled only while a page shows it. */
export const statusApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method, path }) => {
    if (method !== "GET") return json(405, { error: "GET" });
    // /api/status, or /api/status/<view>: what each Status tab reads.
    const view = path.split("/")[3] ?? "overview";
    if (!statusViews.includes(view as StatusView)) return json(404, { error: "No such view." });
    const status = await readNetworkStatus({ intentPath, platform, view: view as StatusView });
    return status ? json(200, status) : json(409, { error: "The saved settings are not valid." });
  };

/** POST {device, service}: restart a service the settings declare on that device (a Status fix). */
export const fixApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method, body }) => {
    if (method !== "POST") return json(405, { error: "POST" });
    let input: { device?: unknown; service?: unknown };
    try {
      input = JSON.parse(body || "{}");
    } catch {
      return json(400, { error: "The body is not JSON." });
    }
    if (typeof input.device !== "string" || typeof input.service !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.service)) {
      return json(400, { error: "Give a device and a service." });
    }
    const result = await restartService({ intentPath, platform, hostname: input.device, service: input.service });
    return json("error" in result ? 502 : 200, result);
  };

/** POST: the router's download speed now. GET /api/firmware: OpenWrt's latest release. */
export const internetSpeedApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method }) => {
    if (method !== "POST") return json(405, { error: "POST" });
    const result = await speedTest({ intentPath, platform });
    return json("error" in result ? 502 : 200, result);
  };

export const firmwareApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method }) => {
    if (method !== "GET") return json(405, { error: "GET" });
    const result = await latestRelease({ intentPath, platform });
    return json("error" in result ? 502 : 200, result);
  };

/** GET: what an apply would change on each device, as UCI, read from the devices now (src/applyDiff.ts). */
export const applyDiffApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method }) => {
    if (method !== "GET") return json(405, { error: "GET" });
    if (!compiled(platform, intentPath)) return json(409, { error: "The saved settings are not valid." });
    // Not while an apply runs: it would log in to devices mid-change.
    if ((await provisionStatus({ intentPath, files: platform })).state === "running") {
      return json(409, { error: "Settings are being applied." });
    }
    return json(200, { devices: await readApplyDiff({ intentPath, platform }) });
  };

/** POST {from, to}: a mesh link's speed, measured now (src/meshSpeed.ts). Sends test traffic; changes nothing. */
export const meshSpeedApi =
  ({ intentPath, platform }: { intentPath: string; platform: Platform }): HttpHandler =>
  async ({ method, body }) => {
    if (method !== "POST") return json(405, { error: "POST" });
    let input: { from?: unknown; to?: unknown };
    try {
      input = JSON.parse(body || "{}");
    } catch {
      return json(400, { error: "The body is not JSON." });
    }
    if (typeof input.from !== "string" || typeof input.to !== "string" || input.from === input.to) {
      return json(400, { error: "Give two devices: from and to." });
    }
    const result = await measureLink({ intentPath, platform, from: input.from, to: input.to });
    return json("error" in result ? 502 : 200, result);
  };

const withCookie = (response: HttpResponse, sid: string | undefined): HttpResponse => ({
  ...response,
  headers: { ...response.headers, "set-cookie": sessionSetCookie(sid) },
});

/** POST {password}: a session (cookie) for the router's root password; or ends it. */
/** Wrong passwords allowed within the window, from anywhere, before logins pause. */
const loginAttempts = 5;
const loginWindowMs = 60_000;

const sessionApi =
  ({
    auth,
    platform,
    intentPath,
    now = Date.now,
  }: {
    auth: Auth;
    platform: Pick<Platform, "sleep" | "writeTextFile" | "mkdirp" | "removeFile" | "run">;
    intentPath: string;
    now?: () => number;
  }): HttpHandler =>
  async (request) => {
    if (request.method !== "POST") return json(405, { error: "POST" });
    if (request.path === "/api/logout") {
      await auth.logout(request);
      return withCookie(json(200, { ok: true }), undefined);
    }
    let password: unknown;
    try {
      password = JSON.parse(request.body || "{}").password;
    } catch {
      return json(400, { error: "The body is not JSON." });
    }
    // Every attempt is a file of its own, made before the password is
    // checked and then counted with the others of the last minute: under CGI
    // each request is its own process, and attempts sent side by side must
    // see each other (making a file is atomic; reading and rewriting a count
    // is not). A success removes its own; failures stay until they age out.
    const dir = `${intentPath}.state/login-attempts`;
    platform.mkdirp(dir);
    const mine = `${now()}-${Math.random().toString(36).slice(2, 10)}`;
    platform.writeTextFile(`${dir}/${mine}`, "");
    const listed = await platform.run(["ls", dir]).catch(() => ({ stdout: "" }));
    const recent = listed.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => {
        const at = Number(name.split("-")[0]);
        if (!name || !Number.isFinite(at)) return false;
        if (now() - at >= loginWindowMs) {
          platform.removeFile(`${dir}/${name}`);
          return false;
        }
        return true;
      });
    if (recent.length > loginAttempts) {
      return json(429, { error: "Too many wrong passwords: wait a minute and try again." });
    }
    const sid = typeof password === "string" && password ? await auth.login(password) : undefined;
    if (!sid) {
      await platform.sleep(1000);
      return json(401, { error: "That is not the router's password." });
    }
    platform.removeFile(`${dir}/${mine}`);
    return withCookie(json(200, { ok: true }), sid);
  };

export const uiHandler = ({
  intentPath,
  uiRoot,
  platform,
  auth,
}: {
  intentPath: string;
  uiRoot: string;
  platform: Platform;
  /** On a router: every API request must carry a session (src/server/auth.ts). None on the Mac's loopback server. */
  auth?: Auth;
}): HttpHandler => {
  const routes: Record<string, HttpHandler> = {
    "/api/intent": intentApi({ intentPath, files: platform }),
    "/api/provision": provisionApi({ intentPath, platform }),
    "/api/devices": devicesApi({ intentPath, platform }),
    "/api/apply/diff": applyDiffApi({ intentPath, platform }),
    "/api/status": statusApi({ intentPath, platform }),
    "/api/admin/key": ownKeyApi({ intentPath, platform }),
    "/api/discover": discoverApi({ intentPath, platform }),
    "/api/discover/inspect": discoverApi({ intentPath, platform }),
    "/api/discover/adopt": discoverApi({ intentPath, platform }),
    "/api/mesh/speed": meshSpeedApi({ intentPath, platform }),
    "/api/fix": fixApi({ intentPath, platform }),
    "/api/internet/speed": internetSpeedApi({ intentPath, platform }),
    "/api/firmware": firmwareApi({ intentPath, platform }),
    ...Object.fromEntries(statusViews.map((v) => [`/api/status/${v}`, statusApi({ intentPath, platform })])),
  };
  const ui = staticFiles({ root: uiRoot, files: platform });
  const session = auth && sessionApi({ auth, platform, intentPath });
  return async (request) => {
    const api = request.path.startsWith("/api/");
    // Every API request must carry a header a cross-site page cannot send
    // without a CORS preflight, which is never granted: no CSRF on any
    // transport, and no reads either (a GET of /api/status logs in to the
    // devices, which an <img> on any page could otherwise make it do).
    if (api && request.headers["x-onc"] !== "1") return json(403, { error: "Missing the X-ONC header." });
    if (session && (request.path === "/api/login" || request.path === "/api/logout")) return session(request);
    // On a router, logged in: the UI's own files are no secret, the API is.
    if (api && auth && !(await auth.check(request))) return json(401, { error: "Log in first.", login: true });
    return (routes[request.path] ?? ui)(request);
  };
};

/** A response in CGI's format: a Status header, the headers, then the body. */
export const cgiResponse = (response: HttpResponse) =>
  [
    `Status: ${response.status}`,
    ...Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`),
    "",
    response.body,
  ].join("\r\n");
