// The intent file: read it (in the current format, with the schema's
// defaults filled in) and save it (validated, compiled, versioned). The
// saved file's version (its sha256) travels with a page: a save or an apply
// naming another version (the file changed in another tab, or by the CLI,
// since) is refused rather than undoing that change.
import { keepSiteSeed } from "../../intent/edits";
import { Intent, intentSchema } from "../../intent/schema";
import { HttpRequest, HttpResponse, Platform } from "../../platform";
import { renameFacts } from "../../deviceFacts";
import { problem } from "../../problem";
import { checkedIntent, intentFileOrNothing, readIntentFile, writeIntentFile } from "../../settings";
import { ApiContext, json, problemResponse, respond, Route, withBody } from "../router";

type Files = Pick<Platform, "readTextFile" | "sha256">;

export const versionHeader = "x-onc-version";

export const versionOf = (files: Files, path: string) => {
  try {
    return files.sha256(files.readTextFile(path));
  } catch {
    return "";
  }
};

export const withVersion = (response: HttpResponse, version: string): HttpResponse => ({
  ...response,
  headers: { ...response.headers, [versionHeader]: version },
});

/** The request names a version of the file other than the one saved now. */
export const changedElsewhere = (files: Files, path: string, request: HttpRequest) =>
  request.headers[versionHeader] !== undefined && request.headers[versionHeader] !== versionOf(files, path);

/** A device renamed in place (same position in Hardware, its old name gone, its new one new) keeps its facts, pinned host key and all. */
const keepRenamedFacts = (files: Parameters<typeof renameFacts>[0], intentPath: string, before: Intent, after: Intent) => {
  const oldNames = before.hardware.map((d) => d.name);
  const newNames = after.hardware.map((d) => d.name);
  after.hardware.forEach((d, i) => {
    const was = oldNames[i];
    if (was && was !== d.name && !newNames.includes(was) && !oldNames.includes(d.name)) renameFacts(files, intentPath, was, d.name);
  });
};

export const intentRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => [
  {
    path: "/api/intent",
    // In the current format, the only one the UI knows, and with the
    // schema's defaults filled in: a setting a file leaves out must show as
    // its default, or saving would write whatever the control showed. An
    // invalid file comes back as written, for the UI to flag.
    GET: async () => respond(readIntentFile(platform, intentPath), (intent) => withVersion(json(200, intent), versionOf(platform, intentPath))),
    PUT: withBody(async (input, request) => {
      if (changedElsewhere(platform, intentPath, request)) {
        return problemResponse(
          problem("conflict", "The settings were changed elsewhere since this page read them: yours are kept, check them, then save again.", {
            details: { changedElsewhere: true },
          })
        );
      }
      // Valid and compiling, as every write of the settings is (checkedIntent).
      const checked = checkedIntent(input);
      if (!checked.ok) return problemResponse(checked.error);
      const before = intentSchema.safeParse(intentFileOrNothing(platform, intentPath));
      const intent = before.success ? keepSiteSeed(before.data, checked.value) : checked.value;
      const written = writeIntentFile(platform, intentPath, intent, { keepOld: "older-format", at: now() });
      if (!written.ok) return problemResponse(written.error);
      if (before.success) keepRenamedFacts(platform, intentPath, before.data, intent);
      return withVersion(json(200, intent), versionOf(platform, intentPath));
    }),
  },
];
