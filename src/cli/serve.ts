// The web UI: served on this machine (`ui`), answered one request at a time
// under uhttpd on a router (`cgi`), and the router's status collector
// (`collect`; `ui` runs its own).
import { intentFileOrNothing } from "../settings";
import { stateLayout } from "../store";
import { CommandSpec, OptionSpec } from "../args";
import { loopbackHosts } from "../platform";
import { readReleases } from "../firmware/releases";
import { finishSelfUpgrade } from "../firmware/self";
import { uiHandler } from "../server/app";
import { rpcdAuth } from "../server/auth";
import { cgiRequest, cgiResponse } from "../server/cgi";
import { routerNames } from "../server/hosts";
import { runCollector } from "../status/collector";
import { CliContext } from "./context";

/** On a router: what the collector reads, in RAM (never flash: it is rewritten every few seconds). */
const routerStatusDir = "/tmp/onc-collector";

const uiOptions = (uiDir: string): OptionSpec[] => [
  {
    flags: "--ui-dir <dir>",
    description: "the built web UI (npm run ui:build)",
    default: uiDir,
  },
];

export const uiCommand = ({ platform, uiDir }: CliContext): CommandSpec => ({
  name: "ui",
  description:
    "serve the web UI for an intent file on this machine (on a router, uhttpd runs `cgi` instead)",
  args: [{ name: "intent-file", description: "the intent file to edit" }],
  options: [
    ...uiOptions(uiDir),
    { flags: "--port <port>", description: "port to listen on", default: "8080" },
    {
      flags: "--host <host>",
      description: "loopback address to listen on: 127.0.0.1 or ::1 (the API has no login here)",
      default: "127.0.0.1",
    },
  ],
  action: async ([intentPath], options) => {
    if (!platform.serve) {
      throw new Error(
        "This runtime cannot listen on a port. On a router, have uhttpd run `cgi`."
      );
    }
    // No login on this machine: anyone who can reach it could read every
    // password and apply. A router's own UI (`cgi`) has one.
    if (!loopbackHosts.includes(options.host)) {
      throw new Error(`--host ${options.host}: the UI listens on this machine only (127.0.0.1, ::1 or localhost); it has no login here.`);
    }
    console.log(`Serving ${intentPath} at http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${options.port}/`);
    // The Status pages' reads, kept beside the intent while this serves.
    const statusDir = stateLayout(intentPath).status;
    void runCollector({ intentPath, platform, dir: statusDir, everyHour: () => readReleases({ intentPath, platform }) });
    await platform.serve(
      uiHandler({ intentPath, uiRoot: options.uiDir, platform, statusDir }),
      { host: options.host, port: Number(options.port) }
    );
  },
});

export const collectCommand = ({ platform }: CliContext): CommandSpec => ({
  name: "collect",
  description:
    "keep reading the devices for the web UI's Status pages (a router's service; `ui` does it itself)",
  args: [{ name: "intent-file", description: "the intent file whose devices to read" }],
  options: [
    { flags: "--dir <dir>", description: "where to keep what it reads", default: routerStatusDir },
  ],
  action: async ([intentPath], options) => {
    // The first start after the router flashed itself: finished as that run would have (src/firmware/self.ts).
    const finished = await finishSelfUpgrade({ intentPath, platform }).catch(() => undefined);
    if (finished) console.error(finished.message);
    await runCollector({ intentPath, platform, dir: options.dir, everyHour: () => readReleases({ intentPath, platform }) });
  },
});

export const cgiCommand = ({ platform, uiDir }: CliContext): CommandSpec => ({
  name: "cgi",
  description:
    "answer one web UI request as a CGI program (what uhttpd runs on a router)",
  args: [{ name: "intent-file", description: "the intent file to edit" }],
  options: uiOptions(uiDir),
  action: async ([intentPath], options) => {
    const names = routerNames(intentFileOrNothing(platform, intentPath));
    const request = cgiRequest(platform.env, names, platform.readStdin);
    const response =
      "refused" in request
        ? {
            status: request.refused,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ error: request.error }),
          }
        : await uiHandler({
            intentPath,
            uiRoot: options.uiDir,
            platform,
            // On a router, reachable from the network: log in with its root password.
            auth: rpcdAuth(platform),
            // Counted in RAM, not flash: every attempt is a file.
            loginAttemptsDir: "/tmp/onc-login-attempts",
            // What the collector service (`collect`) keeps, in RAM.
            statusDir: routerStatusDir,
          })(request);
    console.log(cgiResponse(response));
    // Answered: a timer still pending (a device read's time limit) must not
    // keep this process, and so the response, open. exit flushes first.
    platform.exit(0);
  },
});
