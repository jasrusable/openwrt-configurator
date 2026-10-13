// A refactor's guard: the working tree must make exactly what <git-ref> makes
// of a fixed corpus (the sample and seeded generated intents), on every
// device and captured board: each device's engine state (config, packages,
// services, files, keeps) and its uci operations, errors alike. Prints the
// first differences as a unified diff and exits 1 on any.
//
// A change made on purpose is listed in an expectations file (default
// scripts/equivalence.expected.json, if there is one): each a text in the
// ref's output and what the working tree makes of it instead, with why.
// The ref's output is read with them applied, so only what nobody meant
// differs; one that no longer occurs (its change committed) is a no-op.
//
// Usage: npm run equivalence -- [<git-ref>, default HEAD] [--cases 60] [--show 5] [--expect <file>]
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateIntents } from "../src/tests/helpers/intentGenerator";
import { sampleIntentJson } from "../src/tests/helpers/fixtures";
import { capturedBoardsRaw } from "../src/tests/helpers/capturedBoards";

const repo = join(__dirname, "..");
const args = process.argv.slice(2);
const valued = ["--cases", "--show", "--expect"];
const ref = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1])) ?? "HEAD";
const optionText = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const option = (name: string, fallback: number) => Number(optionText(name) ?? fallback);

type Expected = { why: string; from: string; to: string };
const expectFile = optionText("expect") ?? join(repo, "scripts/equivalence.expected.json");
const expected: Expected[] = existsSync(expectFile) ? JSON.parse(readFileSync(expectFile, "utf8")) : [];
/** The ref's output as the working tree should make it: each expected change applied. */
const expecting = (out: string) => expected.reduce((text, e) => text.split(e.from).join(e.to), out);

const runHarness = (root: string, input: { corpus: string; boards: string }, out: string) => {
  const result = spawnSync(
    process.execPath,
    [
      "-r",
      join(repo, "node_modules/ts-node/register/transpile-only"),
      join(repo, "scripts/equivalence-harness.ts"),
      input.corpus,
      input.boards,
      out,
    ],
    { cwd: root, env: { ...process.env, TS_NODE_PROJECT: join(root, "tsconfig.json") }, stdio: ["ignore", "inherit", "inherit"] }
  );
  if (result.status !== 0) throw new Error(`The harness failed in ${root}.`);
  return new Map(
    readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { key: string; out: string })
      .map(({ key, out }) => [key, out] as const)
  );
};

const unified = (key: string, before: string | undefined, after: string | undefined, dir: string) => {
  const a = join(dir, "before.txt");
  const b = join(dir, "after.txt");
  writeFileSync(a, (before ?? "(absent)") + "\n");
  writeFileSync(b, (after ?? "(absent)") + "\n");
  const diff = spawnSync("diff", ["-u", "--label", `${ref} ${key}`, "--label", `working tree ${key}`, a, b], { encoding: "utf8" });
  return diff.stdout;
};

const main = () => {
  const dir = mkdtempSync(join(tmpdir(), "onc-equivalence-"));
  const tree = join(dir, "ref");
  try {
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", "--quiet", tree, ref], { stdio: "inherit" });
    symlinkSync(join(repo, "node_modules"), join(tree, "node_modules"));
    const corpus = [sampleIntentJson(), ...generateIntents(option("cases", 60), 7)];
    const input = { corpus: join(dir, "corpus.json"), boards: join(dir, "boards.json") };
    writeFileSync(input.corpus, JSON.stringify(corpus));
    writeFileSync(input.boards, JSON.stringify(capturedBoardsRaw()));
    const before = new Map([...runHarness(tree, input, join(dir, "before.jsonl"))].map(([key, out]) => [key, expecting(out)]));
    const after = runHarness(repo, input, join(dir, "after.jsonl"));
    const keys = [...new Set([...before.keys(), ...after.keys()])];
    const differ = keys.filter((key) => before.get(key) !== after.get(key));
    const errors = [...after.values()].filter((out) => out.startsWith("ERROR")).length;
    console.log(
      `${corpus.length} intents against ${ref}, ${keys.length} device × board outputs (${errors} of them errors, compared too)` +
        `${expected.length ? `, ${expected.length} expected change(s) applied` : ""}: ${differ.length} differ.`
    );
    differ.slice(0, option("show", 5)).forEach((key) => console.log(unified(key, before.get(key), after.get(key), dir)));
    if (differ.length > option("show", 5)) console.log(`… and ${differ.length - option("show", 5)} more: ${differ.slice(option("show", 5), option("show", 5) + 20).join(", ")}`);
    process.exitCode = differ.length ? 1 : 0;
  } finally {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", tree]);
    rmSync(dir, { recursive: true, force: true });
  }
};

main();
