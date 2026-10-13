// One CGI request, as uhttpd hands it over, into the handler's terms. uhttpd
// passes only a fixed set of request headers (Host, Origin, Cookie, ... ;
// verified on 25.12.5: an X-ONC header never arrives), so what the Mac's
// server reads from headers comes another way here: the CSRF check from
// Origin against Host, the saved file's version from the query string.
import { HttpRequest, HttpResponse } from "../platform";
import { hostAllowed } from "./hosts";

type Env = (name: string) => string | undefined;

/** Whether a browser sent this from the router's own pages: writes always carry Origin. */
const sameOrigin = (env: Env) => {
  const origin = env("HTTP_ORIGIN");
  const host = env("HTTP_HOST");
  const method = env("REQUEST_METHOD") || "GET";
  if (origin === undefined || origin === "") return method === "GET" || method === "HEAD";
  return origin === `https://${host}` || origin === `http://${host}`;
};

const queryParam = (query: string | undefined, name: string) =>
  (query ?? "")
    .split("&")
    .map((pair) => pair.split("="))
    .find(([key]) => key === name)?.[1];

/** The request, or why it is refused before anything reads it. */
export const cgiRequest = (
  env: Env,
  routerNames: string[],
  readBody: () => string
): HttpRequest | { refused: number; error: string } => {
  if (!hostAllowed(env("HTTP_HOST"), routerNames)) return { refused: 403, error: "Forbidden." };
  const length = Number(env("CONTENT_LENGTH") || 0);
  // Read before any login is checked, so bounded: an intent, VPN files and
  // all, is far smaller; more is refused unread.
  if (length > maxCgiBody) return { refused: 413, error: "Too large." };
  const version = queryParam(env("QUERY_STRING"), "version");
  const remote = env("REMOTE_ADDR");
  return {
    method: env("REQUEST_METHOD") || "GET",
    path: env("PATH_INFO") || "/",
    body: length > 0 ? readBody() : "",
    ...(remote ? { remoteAddress: remote } : {}),
    headers: {
      "x-onc": sameOrigin(env) ? "1" : "",
      cookie: env("HTTP_COOKIE") ?? "",
      ...(version && /^[0-9a-f]{64}$/.test(version) ? { "x-onc-version": version } : {}),
    },
  };
};

export const maxCgiBody = 2 * 1024 * 1024;

const reasons: Record<number, string> = {
  200: "OK",
  202: "Accepted",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/**
 * A response in CGI's format: a Status line, the headers, then the body.
 * uhttpd takes a status only as "<3 digits> <reason>": a bare code is
 * ignored and the answer goes out as 200 (verified on 25.12.5).
 */
export const cgiResponse = (response: HttpResponse) =>
  [
    `Status: ${response.status} ${reasons[response.status] ?? "Status"}`,
    ...Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`),
    "",
    response.body,
  ].join("\r\n");
