// The only part of the UI that talks to the backend. URLs are relative, so
// the same build works at / (the Mac server) and /cgi-bin/onc/ (a router).
import type { DeviceDiff } from "../../../src/applyDiff";
import type { DeviceFacts, ReadResult } from "../../../src/deviceFacts";
import type { Change } from "../../../src/intent/diff";
import type { Intent } from "../../../src/intent/schema";
import type { ProvisionStatus } from "../../../src/server/provisionJob";

export type Issue = { path: string; message: string };

/** Every write carries it: the server refuses writes without (CSRF). */
const writeHeaders = { "x-onc": "1" };

export class SaveError extends Error {
  constructor(message: string, readonly issues: Issue[] = []) {
    super(message);
  }
}

export const loadIntent = async (): Promise<Intent> => {
  const response = await fetch("api/intent");
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
  const response = await fetch("api/provision");
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

export const loadDeviceFacts = async (): Promise<FactsByDevice> => {
  const response = await fetch("api/devices");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not load what the devices are.");
  return body.facts;
};

/** Reads every device now (read-only, over SSH): only on the user's request. */
export const readDevicesNow = async (): Promise<{ results: ReadResult[]; facts: FactsByDevice }> => {
  const response = await fetch("api/devices", { method: "POST", headers: writeHeaders });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not read the devices.");
  return body;
};

export const loadApplyDiff = async (): Promise<DeviceDiff[]> => {
  const response = await fetch("api/apply/diff");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not work out the changes.");
  return body.devices;
};
