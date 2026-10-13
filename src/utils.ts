import { z, ZodTypeAny } from "zod";

/** A value parsed by a schema, or an error listing each issue by path. */
export const parseSchema = <S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> => {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path.join("."), code: issue.code }));
  throw new Error(`Failed to parse schema. Parsing issues: ${JSON.stringify(issues, null, 4)}`);
};

export { parseJson } from "./parseJson";
