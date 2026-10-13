import { z, ZodObject, ZodRawShape, ZodSchema, ZodTypeAny } from "zod";

export const parseSchema = <S extends ZodTypeAny>(
  schema: S,
  data: any
): z.output<S> => {
  try {
    return schema.parse(data);
  } catch (e: any) {
    const issues = e?.issues;
    const parsedIssues = issues
      ? issues.map((issue: any) => ({
          message: issue.message,
          path: issue.path.join("."),
          code: issue.code,
        }))
      : undefined;
    throw new Error(
      `Failed to parse schema. ${
        parsedIssues
          ? `Parsing issues: ${JSON.stringify(parsedIssues, null, 4)}`
          : ""
      }`
    );
  }
};

export const conditionSchema = z.string();

export type Condition = z.infer<typeof conditionSchema>;

export const getExtensionObject = (schema?: z.ZodObject<any>) => {
  const extensionObject = {
    ".if": conditionSchema.optional(),
    ".overrides": z
      .array(
        z.object({
          ".if": conditionSchema,
          override: schema ? schema.partial() : z.any(),
        })
      )
      .optional(),
  };

  return extensionObject;
};

export const getExtensionSchema = (schema?: z.ZodObject<any>) => {
  const extensionSchema = z.object(getExtensionObject(schema));
  return extensionSchema;
};

const temp = getExtensionSchema();

export type ExtensionSchema = z.infer<typeof temp>;

export const sectionSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return z.array(schema.extend({ ".name": nameValidation })).optional();
};

/**
 * A section name reaches `uci batch` as an unquoted identifier, and uci's
 * tokenizer terminates unquoted tokens at whitespace and at `#`. The previous
 * pattern was unanchored, so it only required the name to *contain* one
 * alphanumeric — `foo bar` and `foo#bar` passed here and failed mid-provision
 * instead of at parse time with a usable message.
 */
export const nameValidation = z
  .string()
  .regex(
    /^[0-9a-zA-Z_]+$/,
    // uci refuses a hyphen in a section name (verified on 25.12.5).
    "must contain only letters, digits or underscores"
  );

export const oncSectionSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return z
    .array(
      schema.partial().extend({
        ".name": nameValidation.optional(),
        ...getExtensionObject(schema),
      })
    )
    .optional();
};

export const configSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return schema.optional();
};

export const makeOncConfigSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return schema.extend(getExtensionObject(schema));
};

export { parseJson } from "./parseJson";
