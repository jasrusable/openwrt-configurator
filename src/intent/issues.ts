// A problem with an intent at its setting's dotted path: what an invalid save
// answers, and where the UI shows it.
import { z } from "zod";

export type Issue = { path: string; message: string };

/** Each of the schema's issues at its setting's path. */
export const issuesAt = (error: z.ZodError): Issue[] =>
  error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
