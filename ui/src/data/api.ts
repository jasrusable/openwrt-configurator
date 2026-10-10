// The only part of the UI that talks to the backend. URLs are relative, so
// the same build works at / (the Mac server) and /cgi-bin/onc/ (a router).
import type { Intent } from "../../../src/intent/schema";

export type Issue = { path: string; message: string };

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new SaveError(body.error ?? "Some settings need fixing.", body.issues);
  }
  return body;
};
