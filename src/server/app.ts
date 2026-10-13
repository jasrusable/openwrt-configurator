// The web UI's backend: one handler for the API (src/server/api/) and the
// UI's static files. Transport-free, so the Node server (`ui`) and CGI under
// uhttpd on a router (`cgi`) answer every request with the same code. The UI
// uses relative URLs, so it works wherever it is mounted: / on a Mac,
// /cgi-bin/onc/ on a router.
import { HttpHandler, HttpRequest, HttpResponse, Platform } from "../platform";
import { actionRoutes } from "./api/actions";
import { devicesRoutes } from "./api/devices";
import { discoverRoutes } from "./api/discover";
import { firmwareRoutes } from "./api/firmware";
import { intentRoutes } from "./api/intent";
import { provisionRoutes } from "./api/provision";
import { sessionRoutes } from "./api/session";
import { staticFiles } from "./api/static";
import { statusRoutes } from "./api/status";
import { patchesRoutes } from "./api/patches";
import { backupRoutes } from "./api/backup";
import { Auth } from "./auth";
import { ApiContext, refuse, router } from "./router";
import { messageOf } from "../result";
import { keepStatePrivate, stateLayout } from "../store";

/** Never inside another page's frame: there its own clicks (same origin, header and all) could be lured into a Save or an Apply. */
const unframed = (response: HttpResponse): HttpResponse => ({
  ...response,
  headers: { ...response.headers, "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" },
});

export const uiHandler = ({
  intentPath,
  uiRoot,
  platform,
  auth,
  loginAttemptsDir,
  statusDir = stateLayout(intentPath).status,
  now = Date.now,
}: {
  intentPath: string;
  uiRoot: string;
  platform: Platform;
  /** Where the status collector keeps what it read (on a router, RAM). */
  statusDir?: string;
  /** Where wrong passwords are counted (src/server/api/session.ts). */
  loginAttemptsDir?: string;
  /** On a router: every API request must carry a session (src/server/auth.ts). None on the Mac's loopback server. */
  auth?: Auth;
  now?: () => number;
}): HttpHandler => {
  // Made private here, before anything is kept in it (an old one tightened).
  try {
    keepStatePrivate(platform, intentPath);
  } catch {
    // A directory that cannot be made yet: the first write says why.
  }
  const context: ApiContext = { intentPath, platform, statusDir, now };
  const notFound = async () => refuse("not-found", "Not found.");
  const api = router(
    [intentRoutes, provisionRoutes, devicesRoutes, statusRoutes, discoverRoutes, actionRoutes, patchesRoutes, firmwareRoutes, backupRoutes].flatMap((routes) => routes(context)),
    notFound
  );
  const session = auth && router(sessionRoutes({ auth, platform, intentPath, attemptsDir: loginAttemptsDir, now }), notFound);
  const ui = staticFiles({ root: uiRoot, files: platform });
  // Every answer goes out, framed as any other: a throw (a bug, never an
  // expected failure, which is a Result) is a 500 that says what it was.
  return async (request) => {
    try {
      return unframed(await answer(request));
    } catch (thrown) {
      return unframed(refuse("internal", messageOf(thrown)));
    }
  };
  async function answer(request: HttpRequest): Promise<HttpResponse> {
    if (!request.path.startsWith("/api/")) return ui(request);
    // Every API request must carry a header a cross-site page cannot send
    // without a CORS preflight, which is never granted: no CSRF on any
    // transport, and no reads either (a GET of /api/status logs in to the
    // devices, which an <img> on any page could otherwise make it do).
    if (request.headers["x-onc"] !== "1") return refuse("forbidden", "Missing the X-ONC header.");
    if (session && (request.path === "/api/login" || request.path === "/api/logout")) return session(request);
    // On a router, logged in: the UI's own files are no secret, the API is.
    if (auth && !(await auth.check(request))) return refuse("unauthorized", "Log in first.", { login: true });
    return api(request);
  }
};
