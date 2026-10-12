// Logging in to the app where it runs on a router (`onc cgi` under uhttpd):
// OpenWrt's own sessions, as LuCI does. The root password is checked by rpcd
// (`session login`), which hands back a session; the browser keeps its id in
// an HttpOnly cookie, and every API request must carry a session rpcd still
// knows and that may write UCI. Asked through ucode's ubus module with the
// request on stdin: never the ubus command line, whose arguments every
// process on the router can read, and no HTTP client (stock 25.12 has no
// curl). Verified on 25.12.5. The Mac's own server (loopback only) needs no login.
import { HttpRequest, Platform } from "../platform";

export type Auth = {
  /** Whether the request carries a live session allowed to change settings. */
  check: (request: HttpRequest) => Promise<boolean>;
  /** A new session for the root password, or undefined when it is wrong. */
  login: (password: string) => Promise<string | undefined>;
  logout: (request: HttpRequest) => Promise<void>;
};

export const sessionCookie = "onc_session";

/** A session id as rpcd makes them: 32 hex digits. */
const sessionId = /^[0-9a-f]{32}$/;

/** The session id the request's cookie holds, if it looks like one. */
export const sessionOf = (request: HttpRequest) => {
  const value = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === sessionCookie)?.[1];
  return value && sessionId.test(value) ? value : undefined;
};

/** The cookie that holds a session, or ends one (an empty value, expired). */
export const sessionSetCookie = (sid: string | undefined) =>
  `${sessionCookie}=${sid ?? ""}; Path=/; HttpOnly; SameSite=Strict${sid ? "" : "; Max-Age=0"}`;

/** One ubus call, its request read from stdin: { result, error }. */
const ubusCall =
  'let q = json(fs.stdin.read("all")); let c = ubus.connect(); let r = c.call(q.object, q.method, q.args); print(sprintf("%J", { result: r, error: c.error() }));';

/** How long a session lasts without use, as LuCI's. */
const sessionSeconds = 3600;

export const rpcdAuth = (platform: Pick<Platform, "run">): Auth => {
  const session = async (method: string, args: object) => {
    try {
      const out = await platform.run(["ucode", "-l", "ubus", "-l", "fs", "-e", ubusCall], {
        stdin: JSON.stringify({ object: "session", method, args }),
      });
      // A wrong password, an unknown or expired session: no result.
      return out.code === 0 ? (JSON.parse(out.stdout)?.result ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    check: async (request) => {
      const sid = sessionOf(request);
      if (!sid) return false;
      // Asking renews it; may it change settings (root's may)?
      const access = await session("access", { ubus_rpc_session: sid, scope: "uci", object: "network", function: "write" });
      return access?.access === true;
    },
    login: async (password) => {
      const data = await session("login", { username: "root", password, timeout: sessionSeconds });
      const sid = data?.ubus_rpc_session;
      return typeof sid === "string" && sessionId.test(sid) ? sid : undefined;
    },
    logout: async (request) => {
      const sid = sessionOf(request);
      if (sid) await session("destroy", { ubus_rpc_session: sid });
    },
  };
};
