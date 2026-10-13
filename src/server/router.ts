// How the web API answers: routes declared as data (a path, exact or a
// prefix, and a handler per method), JSON in and out, and every expected
// failure turned into a status in one place (`respond`).
import { Problem, problem, ProblemKind } from "../problem";
import { Result } from "../result";
import { HttpHandler, HttpRequest, HttpResponse, Platform } from "../platform";

export type Method = "GET" | "POST" | "PUT";

export type Route = {
  path: string;
  /** Also every path under it (`/api/history/<since>`). */
  prefix?: boolean;
} & Partial<Record<Method, HttpHandler>>;

export const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

/**
 * What each kind of failure is, over HTTP: a device or the network failing
 * is the gateway's (502); something failing here is the server's (500).
 */
export const statusOf: Record<ProblemKind, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  unsupported: 405,
  conflict: 409,
  busy: 409,
  "rate-limited": 429,
  internal: 500,
  unreachable: 502,
  failed: 502,
};

/** A problem as the page gets it: `{ error, ...details }` with its kind's status. The only way an error is answered. */
export const problemResponse = (failure: Problem): HttpResponse =>
  json(statusOf[failure.kind], { error: failure.message, ...failure.details });

/** A problem answered at once. */
export const refuse = (kind: ProblemKind, message: string, details?: Record<string, unknown>) =>
  problemResponse(problem(kind, message, details ? { details } : undefined));

/** A Result as an answer: its value as JSON (or as `answer` makes it), its failure as a problem. */
export const respond = <T>(result: Result<T, Problem>, answer: (value: T) => HttpResponse = (value) => json(200, value)) =>
  result.ok ? answer(result.value) : problemResponse(result.error);

/** A request's body as a JSON object ({} when empty); undefined when it is not one. */
const jsonObject = (body: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(body || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** A handler for a JSON object body; anything else is refused before it runs. */
export const withBody =
  (handle: (input: Record<string, unknown>, request: HttpRequest) => Promise<HttpResponse>): HttpHandler =>
  async (request) => {
    const input = jsonObject(request.body);
    return input ? handle(input, request) : refuse("invalid", "The body is not a JSON object.");
  };

/** A string field of a body, trimmed; empty when it is not one. */
export const field = (input: Record<string, unknown>, name: string) =>
  typeof input[name] === "string" ? (input[name] as string).trim() : "";

const matches = (route: Route, path: string) =>
  path === route.path || (!!route.prefix && path.startsWith(`${route.path}/`));

/** The routes' handler for each request; a path none has goes to `otherwise`. */
export const router =
  (routes: Route[], otherwise: HttpHandler): HttpHandler =>
  async (request) => {
    const route = routes.find((r) => matches(r, request.path));
    if (!route) return otherwise(request);
    const handle = route[request.method as Method];
    if (!handle) {
      const allowed = (["GET", "POST", "PUT"] as const).filter((m) => route[m]);
      return refuse("unsupported", `${allowed.join(" or ")}`);
    }
    return handle(request);
  };

/** What every API module is built from. */
export type ApiContext = {
  intentPath: string;
  platform: Platform;
  /** Where the status collector keeps what it read (on a router, RAM). */
  statusDir: string;
  now: () => number;
};
