// The built UI's files (text only), from a directory: every path the API's
// routes do not have.
import { HttpHandler, HttpResponse, Platform } from "../../platform";

const notFound: HttpResponse = { status: 404, headers: {}, body: "Not found" };

const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
};

export const staticFiles =
  ({ root, files }: { root: string; files: Pick<Platform, "readTextFile"> }): HttpHandler =>
  async ({ path }) => {
    const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    if (relative.split("/").some((part) => part === ".." || part === "")) return notFound;
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
