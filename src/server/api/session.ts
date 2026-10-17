// Logging in to the app where it runs on a router (src/server/auth.ts): POST
// /api/login {password} gives a session (a cookie) for the router's root
// password, POST /api/logout ends it. Wrong passwords are counted per client,
// and only per client: a ceiling for everyone together is one any client with
// a few addresses could fill, locking the owner out. This only slows a
// browser; it is not the router's limit, as rpcd's session login is reachable
// through LuCI's /ubus without it.
import { HttpResponse, Platform } from "../../platform";
import { Auth, LoginResult, sessionSetCookie } from "../auth";
import { json, refuse, Route, withBody } from "../router";
import { stateLayout } from "../../store";

const withCookie = (response: HttpResponse, sid: string | undefined, secure: boolean): HttpResponse => ({
  ...response,
  headers: { ...response.headers, "set-cookie": sessionSetCookie(sid, secure) },
});

/**
 * A client as logins are counted: an IPv4 address (also one an IPv6 socket
 * reports as `::ffff:a.b.c.d`), or an IPv6 address's /64, written out in
 * full first, as one device can take any address in it.
 */
export const clientOf = (remote: string) => {
  const address = remote.replace(/%.*$/, "").toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (!address.includes(":")) return address;
  const groups = (part: string) => (part ? part.split(":") : []);
  const [head, tail] = address.split("::");
  const full =
    tail === undefined
      ? groups(head)
      : [...groups(head), ...Array(Math.max(0, 8 - groups(head).length - groups(tail).length)).fill("0"), ...groups(tail)];
  return full
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":");
};

/** Wrong passwords allowed within the window, from one client, before its logins pause. */
const loginAttempts = 5;
const loginWindowMs = 60_000;

export const sessionRoutes = ({
  auth,
  platform,
  intentPath,
  attemptsDir,
  now = Date.now,
}: {
  auth: Auth;
  platform: Pick<Platform, "sleep" | "privateDir" | "writeTextFile" | "listDir" | "removeFile">;
  intentPath: string;
  /** Where attempts are counted: RAM on a router (/tmp), as each one is a file written. */
  attemptsDir?: string;
  now?: () => number;
}): Route[] => [
  {
    path: "/api/logout",
    POST: async (request) => {
      await auth.logout(request);
      return withCookie(json(200, { ok: true }), undefined, !!request.secure);
    },
  },
  {
    path: "/api/login",
    POST: withBody(async (input, request) => {
      const password = input.password;
      // Every attempt is a file of its own, made before the password is
      // checked and then counted with the others of the last minute: under
      // CGI each request is its own process, and attempts sent side by side
      // must see each other (making a file is atomic; reading and rewriting
      // a count is not). A success removes its own; failures stay until they
      // age out. Counted per client, so one on the network guessing cannot
      // keep the owner out; named "<time>-<client>-<random>".
      const dir = attemptsDir ?? stateLayout(intentPath).loginAttempts;
      const client = clientOf(request.remoteAddress ?? "any").replace(/[^A-Za-z0-9]/g, "_");
      const mine = `${now()}-${client}-${Math.random().toString(36).slice(2, 10)}`;
      // The directory must be this program's alone (in /tmp, anyone may make
      // it first): another owner could plant attempts, locking the owner out,
      // or remove them, beating the count.
      try {
        platform.privateDir(dir);
        platform.writeTextFile(`${dir}/${mine}`, "");
      } catch {
        return refuse("internal", `Logins are off: ${dir} is not this app's own (owned by it, mode 700).`);
      }
      const recent = platform
        .listDir(dir)
        .filter((name) => {
          const at = Number(name.split("-")[0]);
          if (!Number.isFinite(at)) return false;
          if (now() - at >= loginWindowMs) {
            platform.removeFile(`${dir}/${name}`);
            return false;
          }
          return true;
        });
      if (recent.filter((name) => name.split("-")[1] === client).length > loginAttempts) {
        // Kept: it counts toward its own client's pause.
        return refuse("rate-limited", "Too many wrong passwords: wait a minute and try again.");
      }
      const result: LoginResult = typeof password === "string" && password ? await auth.login(password) : { refused: "wrong" };
      if ("refused" in result) {
        await platform.sleep(1000);
        return result.refused === "unprotected"
          ? refuse(
              "forbidden",
              "This router has no root password, so any password would log in. Set one first: run passwd on the router (or set this app's password and apply from a computer)."
            )
          : refuse("unauthorized", "That is not the router's password.");
      }
      platform.removeFile(`${dir}/${mine}`);
      return withCookie(json(200, { ok: true }), result.sid, !!request.secure);
    }),
  },
];
