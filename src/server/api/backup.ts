// System › Backup over HTTP: the settings file as stored, and a replacement
// for it (a backup, the defaults, a new network) reviewed, then written
// (src/backup.ts). A write names the version of the file the review was of,
// as a save does: one changed elsewhere since is refused.
import { BackupSource, backupFileName, restoreBackup, reviewBackup } from "../../backup";
import { problem } from "../../problem";
import { readIntentFile } from "../../settings";
import { ApiContext, json, problemResponse, refuse, respond, Route, withBody } from "../router";
import { changedElsewhere, versionOf, withVersion } from "./intent";

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** What a request asks to put in place of the saved settings; undefined when it is not one. */
const sourceOf = (input: Record<string, unknown>): BackupSource | undefined => {
  const source = input.source as Record<string, unknown> | undefined;
  const choices = source?.choices as Record<string, unknown> | undefined;
  switch (source?.from) {
    case "file":
      return text(source.text) === undefined ? undefined : { from: "file", text: text(source.text)! };
    case "defaults":
      return { from: "defaults" };
    case "new": {
      const [name, country, timezone] = [choices?.name, choices?.country, choices?.timezone].map(text);
      return name === undefined || country === undefined || timezone === undefined ? undefined : { from: "new", choices: { name, country, timezone } };
    }
  }
};

export const backupRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => {
  const reviewOf = (input: Record<string, unknown>) => {
    const source = sourceOf(input);
    return source && { source, files: platform, intentPath };
  };
  return [
    {
      path: "/api/backup",
      // The file exactly as stored: `$secret` refs stay refs, nothing filled in.
      GET: async () => {
        let stored: string;
        try {
          stored = platform.readTextFile(intentPath);
        } catch {
          return refuse("not-found", "No settings are saved yet.");
        }
        const read = readIntentFile(platform, intentPath);
        const name = read.ok ? String((read.value as { system?: { name?: unknown } })?.system?.name ?? "") : "";
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
        const asked = reviewOf(input);
        if (!asked) return refuse("invalid", "Say what to restore: a file, the defaults, or a new network.");
        return respond(reviewBackup(asked), ({ review }) => json(200, review));
      }),
    },
    {
      path: "/api/backup/restore",
      POST: withBody(async (input, request) => {
        const asked = reviewOf(input);
        if (!asked) return refuse("invalid", "Say what to restore: a file, the defaults, or a new network.");
        if (changedElsewhere(platform, intentPath, request)) {
          return problemResponse(
            problem("conflict", "The settings were changed elsewhere since this page read them: review again.", { details: { changedElsewhere: true } })
          );
        }
        const restored = restoreBackup(asked);
        if (!restored.ok) return problemResponse(restored.error);
        // As GET /api/intent answers it, so the page carries on from what is now saved.
        return respond(readIntentFile(platform, intentPath), (intent) =>
          withVersion(json(200, { review: restored.value, intent }), versionOf(platform, intentPath))
        );
      }),
    },
  ];
};
