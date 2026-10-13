// A config file, an intent or a hand-written low-level one, read into a
// plan: `$secret` refs resolved, then an intent compiled or a low-level
// config read (src/lowLevel/), and the plan checked once (src/plan/check.ts)
// whichever it came from. Every command takes either. A failure is a
// Problem of the kind it is, decided where it happens: no file, a file that
// cannot be read, a secret that cannot be, or settings that are not valid.
import { findPlaintextSecrets, defaultSecretSource, resolveSecrets, SecretLookup } from "./secrets";
import { Platform } from "./platform";
import { parseConfigJson } from "./parseJson";
import { compileIntent, isIntent } from "./intent/compile";
import { migrateIntent } from "./intent/migrations";
import { Intent, intentSchema } from "./intent/schema";
import { lowLevelSchema, LowLevelConfig } from "./lowLevel/schema";
import { planOfLowLevel } from "./lowLevel/parse";
import { planIssues } from "./plan/check";
import { ConfigIssue } from "./plan/rules";
import { Plan } from "./plan/types";
import { fail, Problem } from "./problem";
import { messageOf, ok, Result } from "./result";
import { z } from "zod";

export type LoadedConfig = {
  plan: Plan;
  /** Values that came from `$secret` refs, by name (for redacting them wherever they are printed). */
  secrets: Map<string, string>;
  /** The intent, when the file is one. */
  intent?: Intent;
  /** The low-level config as written (checked), when the file is one. */
  lowLevel?: LowLevelConfig;
};

/** Issues as one message, each by where it is. */
export const issuesText = (issues: ConfigIssue[]) => issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ");

const zodIssues = (error: z.ZodError): ConfigIssue[] => error.issues.map((i) => ({ path: i.path, message: i.message }));

/** A plan, if it passes its check; else why not. */
const checked = (plan: Plan, what: string): Result<Plan, Problem> => {
  const issues = planIssues(plan);
  return issues.length ? fail("invalid", `${what}: ${issuesText(issues)}`, { details: { issues } }) : ok(plan);
};

/** A parsed config (`$secret` refs resolved) as a plan: an intent compiled, a low-level config read. */
export const planOfJson = (
  value: unknown
): Result<{ plan: Plan; intent?: Intent; lowLevel?: LowLevelConfig }, Problem> => {
  if (isIntent(value)) {
    const intent = intentSchema.safeParse(migrateIntent(value));
    if (!intent.success) return fail("invalid", `The intent is not valid: ${issuesText(zodIssues(intent.error))}`, { details: { issues: zodIssues(intent.error) } });
    const plan = checked(compileIntent(intent.data), "The intent compiles to a config that is not valid (a bug in the compiler)");
    return plan.ok ? ok({ plan: plan.value, intent: intent.data }) : plan;
  }
  const lowLevel = lowLevelSchema.safeParse(value);
  if (!lowLevel.success) return fail("invalid", `The config is not valid: ${issuesText(zodIssues(lowLevel.error))}`, { details: { issues: zodIssues(lowLevel.error) } });
  let read: Plan;
  try {
    read = planOfLowLevel(lowLevel.data);
  } catch (thrown) {
    // A condition that does not parse, or names what no device has.
    return fail("invalid", `The config is not valid: ${messageOf(thrown)}`);
  }
  const plan = checked(read, "The config is not valid");
  return plan.ok ? ok({ plan: plan.value, lowLevel: lowLevel.data }) : plan;
};

export const loadConfig = async ({
  path: configPath,
  platform,
  lookup,
}: {
  path: string;
  platform: Platform;
  /** Overrides where `$secret` refs are looked up (tests inject one). */
  lookup?: SecretLookup;
}): Promise<Result<LoadedConfig, Problem>> => {
  if (platform.fileMode(configPath) === undefined) return fail("not-found", `No config at ${configPath}.`);
  let json: unknown;
  try {
    json = platform.readTextFile(configPath);
  } catch (thrown) {
    return fail("internal", `${configPath} cannot be read: ${messageOf(thrown)}`);
  }
  try {
    json = parseConfigJson(json as string, configPath);
  } catch (thrown) {
    return fail("invalid", messageOf(thrown));
  }
  if (isIntent(json)) {
    // An intent file keeps its passwords, so only its owner may read it.
    const mode = platform.fileMode(configPath);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      console.warn(`Warning: ${configPath} holds passwords but is readable by others; chmod 600 it.`);
    }
  } else {
    for (const path of findPlaintextSecrets(json)) {
      console.warn(`Warning: ${path} is stored in plaintext; use { "$secret": "name" } and \`openwrt-configurator secrets set <name>\`.`);
    }
  }
  const source = lookup ? { lookup, describeMissing: undefined } : defaultSecretSource(platform);
  const resolved = await resolveSecrets(json, source.lookup, source.describeMissing);
  if (!resolved.ok) return resolved;
  const read = planOfJson(resolved.value.value);
  return read.ok ? ok({ ...read.value, secrets: resolved.value.secrets }) : read;
};

/** loadConfig for the CLI and tests: its failure thrown, in its own words. */
export const loadConfigOrThrow = async (options: Parameters<typeof loadConfig>[0]): Promise<LoadedConfig> => {
  const loaded = await loadConfig(options);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
};
