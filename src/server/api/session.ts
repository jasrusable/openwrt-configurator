// Logging in to the app where it runs on a router (src/server/auth.ts): POST
// /api/login {password} gives a session (a cookie) for the router's root
// password, POST /api/logout ends it. Wrong passwords are counted per client.
import { shellQuote } from "../../shell";
import { HttpResponse, Platform } from "../../platform";
import { Auth, LoginResult, sessionSetCookie } from "../auth";
import { json, refuse, Route, withBody } from "../router";
import { stateLayout } from "../../store";

const withCookie = (response: HttpResponse, sid: string | undefined): HttpResponse => ({
  ...response,
  headers: { ...response.headers, "set-cookie": sessionSetCookie(sid) },
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
/** From everyone together: a client with many addresses (IPv6 has endless) is held by this. */
const loginAttemptsAll = 30;
const loginWindowMs = 60_000;

export const sessionRoutes = ({
  auth,
  platform,
  intentPath,
  attemptsDir,
  now = Date.now,
}: {
  auth: Auth;
  platform: Pick<Platform, "sleep" | "writeTextFile" | "removeFile" | "run">;
  intentPath: string;
  /** Where attempts are counted: RAM on a router (/tmp), as each one is a file written. */
  attemptsDir?: string;
  now?: () => number;
}): Route[] => [
  {
    path: "/api/logout",
    POST: async (request) => {
      await auth.logout(request);
      return withCookie(json(200, { ok: true }), undefined);
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
      const q = shellQuote;
      const listed = await platform
        .run([
          "sh",
          "-c",
          [
            `umask 077; mkdir -p ${q(dir)}`,
            `set -- $(ls -ld ${q(dir)}); case "$1" in drwx------*) ;; *) exit 9 ;; esac; [ -O ${q(dir)} ] || exit 9`,
            `: > ${q(`${dir}/${mine}`)}`,
            `ls ${q(dir)}`,
          ].join("\n"),
        ])
        .catch(() => ({ code: 1, stdout: "" }));
      if (listed.code !== 0) return refuse("internal", `Logins are off: ${dir} is not this app's own (owned by it, mode 700).`);
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
      const fromClient = recent.filter((name) => name.split("-")[1] === client);
      // The ceiling counts only passwords actually checked (a refused attempt
      // is marked "-r"): else one client hammering past its own limit would
      // fill it, and lock the owner out from everywhere.
      const checked = recent.filter((name) => !name.endsWith("-r"));
      if (fromClient.length > loginAttempts || checked.length > loginAttemptsAll) {
        // Kept, for its own client's pause (only itself: counted per client), but marked refused.
        platform.writeTextFile(`${dir}/${mine}-r`, "");
        platform.removeFile(`${dir}/${mine}`);
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
      return withCookie(json(200, { ok: true }), result.sid);
    }),
  },
];
