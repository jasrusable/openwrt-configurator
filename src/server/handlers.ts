// The web UI's backend: one handler for the API and the UI's static files.
// Transport-free, so the Node server (`ui`) and CGI under uhttpd on a router
// (`cgi`) answer every request with the same code. The UI uses relative URLs,
// so it works wherever it is mounted: / on a Mac, /cgi-bin/onc/ on a router.
import { compileIntent } from "../intent/compile";
import { intentSchema } from "../intent/schema";
import { oncConfigSchema } from "../oncConfigSchema";
import { parseConfigJson } from "../parseJson";
import { HttpHandler, HttpResponse, Platform } from "../platform";

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
        return json(200, parseConfigJson(files.readTextFile(intentPath), intentPath));
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
        },
        body: files.readTextFile(`${root}/${relative}`),
      };
    } catch {
      return notFound;
    }
  };

/** Everything the UI needs, behind any transport. */
export const uiHandler = ({
  intentPath,
  uiRoot,
  platform,
}: {
  intentPath: string;
  uiRoot: string;
  platform: Files;
}): HttpHandler => {
  const api = intentApi({ intentPath, files: platform });
  const ui = staticFiles({ root: uiRoot, files: platform });
  return (request) =>
    request.path === "/api/intent" ? api(request) : ui(request);
};

/** A response in CGI's format: a Status header, the headers, then the body. */
export const cgiResponse = (response: HttpResponse) =>
  [
    `Status: ${response.status}`,
    ...Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`),
    "",
    response.body,
  ].join("\r\n");
