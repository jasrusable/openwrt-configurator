// The only part of the UI that talks to the backend. URLs are relative, so
// the same build works at / (the Mac server) and /cgi-bin/onc/ (a router).
import type { DeviceDiff } from "../../../src/applyDiff";
import type { Candidate, Inspected } from "../../../src/discover";
import type { DeviceFacts, ReadAttempt } from "../../../src/deviceFacts";
import type { Change } from "../../../src/intent/diff";
import type { NetworkStatus } from "../../../src/status/network";
import type { Intent } from "../../../src/intent/schema";
import type { ProvisionStatus } from "../../../src/server/provisionJob";

export type Issue = { path: string; message: string };

/** Every write carries it: the server refuses writes without (CSRF). */
// On every request, reads too: a cross-site page cannot send it without a
// CORS preflight, so it cannot make this app log in to the devices.
const writeHeaders = { "x-onc": "1" };

export class SaveError extends Error {
  constructor(message: string, readonly issues: Issue[] = []) {
    super(message);
  }
}

export const loadIntent = async (): Promise<Intent> => {
  const response = await fetch("api/intent", { headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not load the configuration.");
  return body;
};

export const saveIntent = async (intent: Intent): Promise<Intent> => {
  const response = await fetch("api/intent", {
    method: "PUT",
    headers: { "content-type": "application/json", ...writeHeaders },
    body: JSON.stringify(intent),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new SaveError(body.error ?? "Some settings need fixing.", body.issues);
  }
  return body;
};

export type ProvisionInfo = ProvisionStatus & {
  /** The devices a provision reconfigures. */
  devices: string[];
  /** What the saved draft changes compared with what was last provisioned. */
  changes: Change[];
};

export const loadProvision = async (): Promise<ProvisionInfo> => {
  const response = await fetch("api/provision", { headers: writeHeaders });
  if (!response.ok) throw new Error("Could not load the apply status.");
  return response.json();
};

export const startProvision = async () => {
  const response = await fetch("api/provision", {
    method: "POST",
    headers: writeHeaders,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not start applying.");
};

export type FactsByDevice = Record<string, DeviceFacts | undefined>;

/** What each device is, which last read failed, and which are due a read. */
export type Devices = {
  facts: FactsByDevice;
  failures: Record<string, ReadAttempt | undefined>;
  stale: string[];
};

export const loadDevices = async (): Promise<Devices> => {
  const response = await fetch("api/devices", { headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not load what the devices are.");
  return body;
};

/** Reads the stale devices (read-only); the server decides which, and how often. */
export const refreshDevices = async (): Promise<Devices> => {
  const response = await fetch("api/devices", { method: "POST", headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not read the devices.");
  return body;
};

export const loadApplyDiff = async (): Promise<DeviceDiff[]> => {
  const response = await fetch("api/apply/diff", { headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not work out the changes.");
  return body.devices;
};

export const loadNetworkStatus = async (): Promise<NetworkStatus> => {
  const response = await fetch("api/status", { headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not read the network's status.");
  return body;
};

/** This app's own public key, from beside its saved SSH key; null when there is none. */
export const loadOwnKey = async (): Promise<string | null> => {
  const response = await fetch("api/admin/key", { headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not read this app's key.");
  return body.publicKey;
};

export const loadCandidates = async (): Promise<{ candidates: Candidate[]; error?: string }> => {
  const response = await fetch("api/discover", { headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not look at the network.");
  return body;
};

const post = async <T>(path: string, input: unknown, failure: string): Promise<T> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...writeHeaders },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? failure);
  return body;
};

/** Reads the device at `address` (read-only); the server keeps the read for adopting. */
export const inspectDevice = (address: string) =>
  post<Inspected>("api/discover/inspect", { address }, "Could not read the device.");

/** Keeps the read device's facts under `name`, so it is found by identity from now on. */
export const adoptDevice = (address: string, name: string) =>
  post<{ ok: true }>("api/discover/adopt", { address, name }, "Could not take on the device.");

/** A mesh link's speed, measured now from one node to the other (sends test traffic). */
export const measureMeshLink = async (link: { from: string; to: string }): Promise<{ mbps: number }> => {
  const response = await fetch("api/mesh/speed", {
    method: "POST",
    headers: { "content-type": "application/json", ...writeHeaders },
    body: JSON.stringify(link),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not measure the link.");
  return body;
};
