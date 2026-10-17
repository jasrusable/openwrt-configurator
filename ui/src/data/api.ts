// The only part of the UI that talks to the backend. URLs are relative, so
// the same build works at / (the Mac server) and /cgi-bin/onc/ (a router).
import type { ServedApplyPlan } from "../../../src/server/api/provision";
import type { BackupReview, BackupSource } from "../../../src/backup";
import type { Candidate, Inspected } from "../../../src/discover";
import type { DeviceFacts, ReadAttempt } from "../../../src/deviceFacts";
import type { Change } from "../../../src/intent/diff";
import type { Releases } from "../../../src/firmware/target";
import type { SelfUpgradeResult } from "../../../src/firmware/self";
import type { NetworkStatus } from "../../../src/status/network";
import type { History, Range } from "../../../src/status/history";
import type { SpeedTest, Survey, TraceHop } from "../../../src/status/actions";
import type { NetworkEvent } from "../../../src/status/events";
import type { KnownClient } from "../../../src/status/registry";
import type { ClientMove } from "../../../src/status/moves";
import type { Intent } from "../../../src/intent/schema";
import type { ProvisionStatus } from "../../../src/apply/job";
import type { Acknowledgements } from "../../../src/firmware/target";

import { forgetDeviceReads } from "./persist";
import { forgetEdits } from "../form/stash";

import type { Issue } from "../../../src/intent/issues";

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
    forgetEdits();
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

/**
 * Sends JSON. With `version` (a saved file's, "" for none saved), the server
 * refuses it if the file is no longer that one: as a header, and in the URL
 * for a router, where uhttpd passes the CGI no custom header (src/server/cgi.ts).
 */
const sendJson = (path: string, input: unknown, { method = "POST", version }: { method?: string; version?: string } = {}) =>
  call(version === undefined ? path : `${path}?version=${encodeURIComponent(version)}`, {
    method,
    headers: { "content-type": "application/json", ...(version === undefined ? {} : { "x-onc-version": version }) },
    body: JSON.stringify(input),
  });

/** A JSON POST that says what went wrong in words. */
const postJson = async <T,>(path: string, input: unknown, failed: string, version?: string): Promise<T> =>
  bodyOf<T>(await sendJson(path, input, { version }), failed);

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
/** The saved file's version as last read or written here (undefined: none saved, or not read yet). */
export const savedVersion = () => intentVersion;

/** Writes of the file begun and ended: a read answered across one is of the file before it. */
let writes = 0;

/** A write of the saved file: its new version kept, and reads that cross it read again. */
const writing = async <T,>(write: () => Promise<T>): Promise<T> => {
  writes++;
  try {
    return await write();
  } finally {
    writes++;
  }
};

/** No settings are saved here yet: the first run, which starts a network or restores one. */
export class NoSettingsError extends Error {}

/** The saved file does not read (not JSON, from a newer app, holding refs): it can still be downloaded and replaced. */
export class UnreadableSettingsError extends Error {}

export const loadIntent = async (): Promise<Intent> => {
  const before = writes;
  const response = await call("api/intent");
  // Sent before a save answered and answered after it: the file it read is
  // gone, and its version would make the next save look out of date.
  if (writes !== before) return loadIntent();
  if (response.status === 404) {
    // Nothing saved: a write must not name the version of a file now gone.
    intentVersion = undefined;
    throw new NoSettingsError("No settings are saved yet.");
  }
  if (response.status === 409) {
    intentVersion = undefined;
    throw new UnreadableSettingsError((await response.json().catch(() => undefined))?.error ?? "The saved settings do not read.");
  }
  const body = await bodyOf<Intent>(response, "Could not load the configuration.");
  intentVersion = response.headers.get("x-onc-version") ?? undefined;
  return body;
};

export const saveIntent = (intent: Intent): Promise<Intent> =>
  writing(async () => {
    const response = await sendJson("api/intent", intent, { method: "PUT", version: intentVersion });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new SaveError(body?.error ?? "Not saved.", body?.issues, !!body?.changedElsewhere);
    }
    intentVersion = response.headers.get("x-onc-version") ?? undefined;
    return body;
  });

/** The settings file as stored, saved by the browser under the name the server gives it. */
export const downloadBackup = async (): Promise<void> => {
  const response = await call("api/backup");
  if (!response.ok) await bodyOf(response, "Could not download the settings.");
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "settings.json";
  const url = URL.createObjectURL(await response.blob());
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** A review, and the version of the saved file it was of ("" with none saved), for the restore to name. */
export type Reviewed = { review: BackupReview; version: string };

/** What putting `source` in place of the saved settings would change, or why it cannot (src/backup.ts). */
export const reviewBackup = async (source: BackupSource): Promise<Reviewed> => {
  const response = await sendJson("api/backup/review", { source });
  const review = await bodyOf<BackupReview>(response, "Could not review it.");
  return { review, version: response.headers.get("x-onc-version") ?? "" };
};

/** Why a restore was refused: in words, the review's issues, or the saved settings changed since the review (review again). */
export class RestoreError extends Error {
  constructor(
    message: string,
    readonly issues: BackupReview["issues"] = [],
    readonly changedElsewhere = false
  ) {
    super(message);
  }
}

/**
 * `source` written as the saved settings, if they are still the `version`
 * reviewed ("" for none saved; unchecked without one): the file as now
 * saved, its version kept for the next save.
 */
export const restoreBackup = (source: BackupSource, version?: string): Promise<Intent> =>
  writing(async () => {
    const response = await sendJson("api/backup/restore", { source }, { version });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new RestoreError(body?.error ?? "Not restored.", body?.review?.issues ?? [], !!body?.changedElsewhere);
    }
    intentVersion = response.headers.get("x-onc-version") ?? undefined;
    return body.intent;
  });

export type ProvisionInfo = ProvisionStatus & {
  /** The devices a provision reconfigures. */
  devices: string[];
  /** What the saved draft changes compared with what was last provisioned. */
  changes: Change[];
  /** The server's clock when it answered (deadlines are on it). */
  serverTime: number;
  /** What undoing the last apply puts back, when there is one to undo. */
  previous?: { appliedAt?: number; changes: Change[] };
};

export const loadProvision = () => getJson<ProvisionInfo>("api/provision", "Could not load the apply status.");

/** Upgrade these devices' firmware (every one behind, when none are named), then apply the saved settings. */
export const startUpgrade = ({ devices, acknowledged }: { devices?: string[]; acknowledged: Acknowledgements & { unapplied: boolean } }) =>
  postJson("api/firmware/upgrade", { ...(devices ? { devices } : {}), acknowledged }, "Could not start the upgrade.", intentVersion);

/**
 * Start applying the saved file the reviewed plan was made from (its
 * `version`; refused if the file is another now), and with its `verify`
 * the run stops before arming if a device changed since.
 */
export const startProvision = ({ verify, version }: { verify?: Record<string, string>; version?: string } = {}) =>
  postJson("api/provision", verify ? { verify } : {}, "Could not start applying.", version ?? intentVersion);

/** Apply the settings from before the last apply again; with `restoreSettings`, also make them the saved ones. */
export const undoLastApply = (restoreSettings: boolean) =>
  writing(() => postJson("api/provision/undo", { restoreSettings }, "Could not undo the last apply.", intentVersion));

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

export const loadApplyPlan = () => getJson<ServedApplyPlan>("api/apply/plan", "Could not work out the changes.");

export const loadNetworkStatus = () => getJson<NetworkStatus>("api/status", "Could not read the network's status.");

/** The graphs' points: all of them, or from `since` (ms) on. */
export const loadHistory = (since = 0, range: Range = "day") => {
  const base = range === "day" ? "api/history" : `api/history/${range}`;
  return getJson<History>(since ? `${base}/${since}` : base, "Could not read the graphs.");
};

/** Restart a service the settings declare on a device: a Status fix. */
export const restartService = (device: string, service: string) =>
  postJson<{ ok: true }>("api/fix", { device, service }, "Could not restart it.");

/** Each access point's survey of the air around it, and those that could not be surveyed. */
export const runWifiSurvey = () =>
  postJson<{ surveys: Survey[]; failed: { accessPoint: string; error: string }[] }>("api/wifi/survey", {}, "The survey did not finish.");

/** Reboot a device: it drops off for a minute or so. */
export const rebootDevice = (device: string) =>
  postJson<{ rebootingSince: number }>("api/device/reboot", { device }, "It did not start rebooting.");

/** Restart a device's Wi-Fi: its clients reconnect within a minute. */
export const restartWifi = (device: string) =>
  postJson<{ ok: true }>("api/device/wifi-restart", { device }, "Its Wi-Fi did not restart.");

/** Ping an address from a device: four pings. */
export const pingFrom = (device: string, target: string) =>
  postJson<{ sent: number; received: number; averageMs?: number }>("api/device/ping", { device, target }, "The ping did not run.");

/** The route from a device to an address: each hop, who answered and in what time. */
export const tracerouteFrom = (device: string, target: string) =>
  postJson<{ hops: TraceHop[] }>("api/device/traceroute", { device, target }, "The traceroute did not run.");

/** The router's speed now, down and up, and how its round trip grows under load: about half a minute. */
export const runSpeedTest = () => postJson<SpeedTest>("api/internet/speed", {}, "The speed test did not finish.");

/** The speed tests kept, the latest first. */
export const loadSpeedTests = () => getJson<SpeedTest[]>("api/internet/speed", "Could not read the speed tests.");

/** Every event kept after `since` (the snapshot carries only the latest). */
export const loadEvents = (since = 0) => getJson<NetworkEvent[]>(`api/events/${since}`, "Could not read what happened.");

/** One client as remembered, and its own series for the last day. */
export const loadClient = (mac: string) =>
  getJson<{ known?: KnownClient; history: History; moves: ClientMove[] }>(`api/clients/${encodeURIComponent(mac)}`, "Could not read this device.");

/** OpenWrt's releases, as last read (asked again when a day old), and why a fresh ask failed. */
export const loadReleases = () =>
  getJson<{ releases?: Releases; error?: string; selfUpgrade?: SelfUpgradeResult }>("api/firmware", "Could not ask OpenWrt.");

/** This app's own public key, from beside its saved SSH key; null when there is none. */
export const loadOwnKey = async () =>
  (await getJson<{ publicKey: string | null }>("api/admin/key", "Could not read this app's key.")).publicKey;

export const loadCandidates = () =>
  getJson<{ candidates: Candidate[] }>("api/discover", "Could not look at the network.");

/** Reads the device at `address` (read-only); the server keeps the read for adopting. */
export const inspectDevice = (address: string) =>
  postJson<Inspected>("api/discover/inspect", { address }, "Could not read the device.");

/** Reads a device in Hardware that was reset, at `address`, its old key there forgotten first. */
export const inspectResetDevice = (address: string, name: string) =>
  postJson<Inspected>("api/discover/inspect-reset", { address, name }, "Could not read the device.");

/** Takes a reset device back under its own name, trusting the key whose fingerprint the user confirmed. */
export const readoptDevice = (address: string, name: string, fingerprint: string) =>
  postJson<{ ok: true }>("api/discover/readopt", { address, name, fingerprint }, "Could not take the device back.");

/** Keeps the read device's facts under `name`, trusting the key whose fingerprint the user confirmed. */
export const adoptDevice = (address: string, name: string, fingerprint: string) =>
  postJson<{ ok: true }>("api/discover/adopt", { address, name, fingerprint }, "Could not take on the device.");

/** A mesh link's speed, measured now from one node to the other (sends test traffic). */
export const measureMeshLink = (link: { from: string; to: string }) =>
  postJson<{ mbps: number }>("api/mesh/speed", link, "Could not measure the link.");
