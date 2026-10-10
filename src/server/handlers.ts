// The web UI's backend: one handler for the API and the UI's static files.
// Transport-free, so the Node server (`ui`) and CGI under uhttpd on a router
// (`cgi`) answer every request with the same code. The UI uses relative URLs,
// so it works wherever it is mounted: / on a Mac, /cgi-bin/onc/ on a router.
import { compileIntent } from "../intent/compile";
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

type JobPlatform = Files & Pick<Platform, "run" | "selfCommand">;

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
        devices: ((draft?.devices as { name: string }[]) || []).map((d) => d.name),
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
          error: "The saved settings are not valid: fix them, save, then provision.",
        });
      }
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
export const uiHandler = ({
  intentPath,
  uiRoot,
  platform,
}: {
  intentPath: string;
  uiRoot: string;
  platform: JobPlatform;
}): HttpHandler => {
  const routes: Record<string, HttpHandler> = {
    "/api/intent": intentApi({ intentPath, files: platform }),
    "/api/provision": provisionApi({ intentPath, platform }),
  };
  const ui = staticFiles({ root: uiRoot, files: platform });
  return (request) =>
    // Writes must carry a header a cross-site page cannot send without a
    // CORS preflight, which is never granted: no CSRF on any transport.
    request.method !== "GET" && request.headers["x-onc"] !== "1"
      ? Promise.resolve(json(403, { error: "Missing the X-ONC header." }))
      : (routes[request.path] ?? ui)(request);
};

/** A response in CGI's format: a Status header, the headers, then the body. */
export const cgiResponse = (response: HttpResponse) =>
  [
    `Status: ${response.status}`,
    ...Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`),
    "",
    response.body,
  ].join("\r\n");
