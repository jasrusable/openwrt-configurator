import test from "ava";
import { readdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "module";
import { join } from "path";

// Everything outside src/platforms/ must run under QuickJS as well as Node, so
// it reaches the runtime only through `platform()`.
const srcDir = join(__dirname, "../..");
const exempt = [join(srcDir, "platforms"), join(srcDir, "tests")];
const nodeOnlyPackages = ["node-ssh", "axios"];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (exempt.includes(path)) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });

const isNodeOnly = (specifier: string) =>
  specifier.startsWith("node:") ||
  builtinModules.includes(specifier.split("/")[0]) ||
  nodeOnlyPackages.includes(specifier);

test("src/ outside platforms/ imports no Node-only modules", (t) => {
  const offenders = sourceFiles(srcDir).flatMap((path) =>
    [...readFileSync(path, "utf-8").matchAll(/from\s+"([^"]+)"|require\("([^"]+)"\)/g)]
      .map((m) => m[1] ?? m[2])
      .filter(isNodeOnly)
      .map((specifier) => `${path.slice(srcDir.length + 1)}: ${specifier}`)
  );
  t.deepEqual(offenders, []);
});

test("src/ outside platforms/ does not touch the process global", (t) => {
  const offenders = sourceFiles(srcDir).filter((path) =>
    /\bprocess\.(env|exit|platform|pid|argv|cwd)\b/.test(
      readFileSync(path, "utf-8")
    )
  );
  t.deepEqual(offenders, []);
});
