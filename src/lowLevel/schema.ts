// A hand-written low-level config's JSON: its shape, checked before it is
// read into a plan (parse.ts). What it means (section types, names, option
// values, placeholders where they stand) is checked once on the plan, as
// for the compiler's (src/plan/check.ts), so the rules live in one place
// (src/plan/rules.ts). Every key that starts with "." is one of the few
// the format has: anything else (`.comment`, `.name` mistyped) is refused.
import { z } from "zod";

const condition = z.string();

/** The keys a section may have that are not options. */
const sectionKeys = [".name", ".if", ".overrides"];

const dotKeys = (allowed: string[]) => (value: Record<string, unknown>, ctx: z.RefinementCtx) =>
  Object.keys(value)
    .filter((key) => key.startsWith(".") && !allowed.includes(key))
    .forEach((key) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `unknown key ${key} (one of ${allowed.join(", ")})` }));

const override = z.object({ ".name": z.string().optional() }).catchall(z.unknown()).superRefine(dotKeys([".name"]));

const section = z
  .object({
    ".name": z.string().optional(),
    ".if": condition.optional(),
    ".overrides": z.array(z.object({ ".if": condition, override }).strict()).optional(),
  })
  .catchall(z.unknown())
  .superRefine(dotKeys(sectionKeys));

const sections = z.array(section);

const config = z
  .object({
    ".if": condition.optional(),
    ".overrides": z.array(z.object({ ".if": condition, override: z.record(sections) }).strict()).optional(),
  })
  .catchall(sections);

const versionSchema = z.union([
  z.string(),
  z
    .object({
      ".value": z.string(),
      ".overrides": z
        .array(z.object({ ".if": condition, override: z.object({ ".value": z.string() }).strict() }).strict())
        .optional(),
    })
    .strict(),
]);

const conditional = { ".if": condition.optional() };

export const lowLevelSchema = z
  .object({
    version: versionSchema.optional(),
    devices: z.array(
      z
        .object({
          enabled: z.boolean().optional(),
          // Optional: read from the device's board.json when absent. Set,
          // it is checked against the device, and build-images needs it.
          model_id: z.string().optional(),
          ipaddr: z.string().optional(),
          hostname: z.string(),
          provision_order: z.number().int().optional(),
          tags: z.record(z.union([z.string(), z.array(z.string())])),
          provisioning_config: z
            .object({
              ssh_auth: z.object({
                username: z.string(),
                password: z.string().optional(),
                private_key_path: z.string().optional(),
              }),
            })
            .optional(),
        })
        .strict()
    ),
    // A leading "-" removes a package.
    package_profiles: z.array(z.object({ ...conditional, packages: z.array(z.string()) }).strict()).optional(),
    services: z
      .array(
        z
          .object({
            ...conditional,
            name: z.string(),
            running: z.boolean().optional(),
            enabled: z.boolean().optional(),
            restart_after_rollback: z.boolean().optional(),
          })
          .strict()
      )
      .optional(),
    files: z
      .array(
        z
          .object({
            ...conditional,
            path: z.string(),
            content: z.string(),
            mode: z.string().optional(),
            run_after: z.string().optional(),
            run_after_reload: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    // `<config>.*` or `<config>.<section type>`, "?" before one the device may lack.
    configs_to_not_reset: z
      .array(
        z
          .object({
            ...conditional,
            configs: z.array(z.string().regex(/^\??[^.\s]+\.[^.\s]+$/, "must be <config>.* or <config>.<section type>")),
          })
          .strict()
      )
      .optional(),
    config: z.record(config),
  })
  .strict();

export type LowLevelConfig = z.infer<typeof lowLevelSchema>;
