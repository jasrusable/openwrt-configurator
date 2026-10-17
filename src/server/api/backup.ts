// System › Backup over HTTP: the settings file as stored, and a replacement
// for it (a backup, the defaults, a new network) reviewed, then written
// (src/backup.ts). A review answers the version of the saved file it was
// of; a restore names it, and one changed since is refused.
import { BackupSource, backupFileName, restoreBackup, reviewBackup } from "../../backup";
import { intentFileOrNothing, readIntentFile } from "../../settings";
import { ApiContext, json, problemResponse, refuse, respond, Route, withBody } from "../router";
import { versionOf, versionHeader, withVersion } from "./intent";

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** What a request asks to put in place of the saved settings; undefined when it is not one. */
const sourceOf = (input: Record<string, unknown>): BackupSource | undefined => {
  const source = input.source as Record<string, unknown> | undefined;
  const choices = source?.choices as Record<string, unknown> | undefined;
  switch (source?.from) {
    case "file": {
      const file = text(source.text);
      return file === undefined ? undefined : { from: "file", text: file };
    }
    case "defaults":
      return { from: "defaults" };
    case "new": {
      const [name, country, timezone, password] = [choices?.name, choices?.country, choices?.timezone, choices?.password].map(text);
      // Root's password may be left out: the review then asks for it.
      return name === undefined || country === undefined || timezone === undefined
        ? undefined
        : { from: "new", choices: { name, country, timezone, ...(password ? { password } : {}) } };
    }
  }
};

const unasked = () => refuse("invalid", "Say what to restore: a file, the defaults, or a new network.");

export const backupRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => [
  {
    path: "/api/backup",
    // The file exactly as stored: its own layout and comments, nothing filled in.
    GET: async () => {
      let stored: string;
      try {
        stored = platform.readTextFile(intentPath);
      } catch {
        return refuse("not-found", "No settings are saved yet.");
      }
      const name = String((intentFileOrNothing(platform, intentPath) as { system?: { name?: unknown } } | undefined)?.system?.name ?? "");
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${backupFileName(name, new Date(now()))}"`,
          "cache-control": "no-store",
        },
        body: stored,
      };
    },
  },
  {
    path: "/api/backup/review",
    POST: withBody(async (input) => {
      const source = sourceOf(input);
      if (!source) return unasked();
      return respond(reviewBackup({ source, files: platform, intentPath, now }), ({ review, version }) => withVersion(json(200, review), version));
    }),
  },
  {
    path: "/api/backup/restore",
    POST: withBody(async (input, request) => {
      const source = sourceOf(input);
      if (!source) return unasked();
      const restored = restoreBackup({ source, files: platform, intentPath, now, version: request.headers[versionHeader] });
      if (!restored.ok) return problemResponse(restored.error);
      // As GET /api/intent answers it, so the page carries on from what is now saved.
      return respond(readIntentFile(platform, intentPath), (intent) =>
        withVersion(json(200, { review: restored.value, intent }), versionOf(platform, intentPath))
      );
    }),
  },
];
