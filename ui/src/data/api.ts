// The only part of the UI that talks to the backend. URLs are relative, so
// the same build works at / (the Mac server) and /cgi-bin/onc/ (a router).
import type { DeviceDiff } from "../../../src/applyDiff";
import type { Candidate, Inspected } from "../../../src/discover";
import type { DeviceFacts, ReadAttempt } from "../../../src/deviceFacts";
import type { Change } from "../../../src/intent/diff";
import type { NetworkStatus } from "../../../src/status/network";
import type { StatusView } from "../../../src/status/read";
import type { Survey } from "../../../src/status/actions";
import type { Intent } from "../../../src/intent/schema";
import type { ProvisionStatus } from "../../../src/server/provisionJob";

import { forgetDeviceReads } from "./persist";

import type { Issue } from "../form/draft";

/** Every write carries it: the server refuses writes without (CSRF). */
// On every request, reads too: a cross-site page cannot send it without a
// CORS preflight, so it cannot make this app log in to the devices.
const writeHeaders = { "x-onc": "1" };

/**
 * On a router the API needs a login (src/server/auth.ts): a 401 says so,
 * and whoever listens (the app's root) shows the login page.
 */
const loginListeners = new Set<() => void>();
export const onLoginNeeded = (listener: () => void) => {
  loginListeners.add(listener);
  return () => void loginListeners.delete(listener);
};

const call = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, { ...init, headers: { ...writeHeaders, ...(init.headers as Record<string, string>) } }).catch(
    () => {
      throw new Error("Could not reach the server.");
    }
  );
  if (response.status === 401) {
    // Logged out: keep nothing of the network in this browser.
    forgetDeviceReads();
    loginListeners.forEach((listener) => listener());
  }
  return response;
};

/**
 * A response's JSON body, or what went wrong in words: the server's own
 * `error`, else `failed` (a proxy's HTML error page is not JSON).
 */
const bodyOf = async <T,>(response: Response, failed: string): Promise<T> => {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(body?.error ?? failed);
  return body as T;
};

const getJson = async <T,>(path: string, failed: string): Promise<T> => bodyOf<T>(await call(path), failed);

/** A JSON POST that says what went wrong in words. */
const postJson = async <T,>(path: string, input: unknown, failed: string): Promise<T> =>
  bodyOf<T>(
    await call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    failed
  );

/**
 * The router's root password for a session (a cookie the browser keeps).
 * Undefined once logged in, else why not: wrong, the router has no password
 * yet, too many tries, or it could not be reached.
 */
export const logIn = async (password: string): Promise<string | undefined> => {
  try {
    await postJson("api/login", { password }, "That is not the router's password.");
  } catch (e) {
    return (e as Error).message === "Could not reach the server." ? "Could not reach the router." : (e as Error).message;
  }
};

export class SaveError extends Error {
  constructor(
    message: string,
    readonly issues: Issue[] = [],
    /** The file was saved elsewhere (another tab, the CLI) since this page read it. */
    readonly changedElsewhere = false
  ) {
    super(message);
  }
}

/**
 * The saved file's version as this page last read or wrote it: sent with a
 * save and an apply, which the server refuses if the file has changed since.
 */
let intentVersion: string | undefined;
const versionHeaders = (): Record<string, string> => (intentVersion ? { "x-onc-version": intentVersion } : {});
/** The same, for a router: uhttpd passes no custom header to the CGI (src/server/cgi.ts). */
const withVersion = (path: string) => (intentVersion ? `${path}?version=${intentVersion}` : path);

export const loadIntent = async (): Promise<Intent> => {
  const response = await call("api/intent");
  const body = await bodyOf<Intent>(response, "Could not load the configuration.");
  intentVersion = response.headers.get("x-onc-version") ?? undefined;
  return body;
};

export const saveIntent = async (intent: Intent): Promise<Intent> => {
  const response = await call(withVersion("api/intent"), {
    method: "PUT",
    headers: { "content-type": "application/json", ...versionHeaders() },
    body: JSON.stringify(intent),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new SaveError(body?.error ?? "Not saved.", body?.issues, !!body?.changedElsewhere);
  }
  intentVersion = response.headers.get("x-onc-version") ?? undefined;
  return body;
};

export type ProvisionInfo = ProvisionStatus & {
  /** The devices a provision reconfigures. */
  devices: string[];
  /** What the saved draft changes compared with what was last provisioned. */
  changes: Change[];
};

export const loadProvision = () => getJson<ProvisionInfo>("api/provision", "Could not load the apply status.");

export const startProvision = async () =>
  bodyOf(await call(withVersion("api/provision"), { method: "POST", headers: versionHeaders() }), "Could not start applying.");

export type FactsByDevice = Record<string, DeviceFacts | undefined>;

/** What each device is, which last read failed, and which are due a read. */
export type Devices = {
  facts: FactsByDevice;
  failures: Record<string, ReadAttempt | undefined>;
  stale: string[];
};

export const loadDevices = () => getJson<Devices>("api/devices", "Could not load what the devices are.");

/** Reads the stale devices (read-only); the server decides which, and how often. */
export const refreshDevices = () => postJson<Devices>("api/devices", undefined, "Could not read the devices.");

export const loadApplyDiff = async () =>
  (await getJson<{ devices: DeviceDiff[] }>("api/apply/diff", "Could not work out the changes.")).devices;

export const loadNetworkStatus = (view: StatusView = "overview") =>
  getJson<NetworkStatus>(`api/status/${view}`, "Could not read the network's status.");

/** Restart a service the settings declare on a device: a Status fix. */
export const restartService = (device: string, service: string) =>
  postJson<{ ok: true }>("api/fix", { device, service }, "Could not restart it.");

/** Each access point's survey of the air around it, and those that could not be surveyed. */
export const runWifiSurvey = () =>
  postJson<{ surveys: Survey[]; failed: { accessPoint: string; error: string }[] }>("api/wifi/survey", {}, "The survey did not finish.");

/** The router's download speed now. */
export const runSpeedTest = () => postJson<{ downMbps: number }>("api/internet/speed", {}, "The speed test did not finish.");

/** OpenWrt's latest stable release. */
export const loadLatestRelease = () => getJson<{ version: string }>("api/firmware", "Could not ask openwrt.org.");

/** This app's own public key, from beside its saved SSH key; null when there is none. */
export const loadOwnKey = async () =>
  (await getJson<{ publicKey: string | null }>("api/admin/key", "Could not read this app's key.")).publicKey;

export const loadCandidates = () =>
  getJson<{ candidates: Candidate[]; error?: string }>("api/discover", "Could not look at the network.");

/** Reads the device at `address` (read-only); the server keeps the read for adopting. */
export const inspectDevice = (address: string) =>
  postJson<Inspected>("api/discover/inspect", { address }, "Could not read the device.");

/** Keeps the read device's facts under `name`, so it is found by identity from now on. */
export const adoptDevice = (address: string, name: string) =>
  postJson<{ ok: true }>("api/discover/adopt", { address, name }, "Could not take on the device.");

/** A mesh link's speed, measured now from one node to the other (sends test traffic). */
export const measureMeshLink = (link: { from: string; to: string }) =>
  postJson<{ mbps: number }>("api/mesh/speed", link, "Could not measure the link.");
