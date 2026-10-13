// UI conventions a reviewer would otherwise have to remember.
import test from "ava";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const uiSrc = join(__dirname, "../../../ui/src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("every hover help is the kit's Hint, never Mantine's Tooltip or HoverCard", (t) => {
  const offenders = files(uiSrc)
    .filter((path) => !path.endsWith(join("kit", "Hint.tsx")))
    .filter((path) => /import \{[^}]*\b(Tooltip|HoverCard)\b[^}]*\} from "@mantine\/core"/.test(readFileSync(path, "utf8")));
  t.deepEqual(offenders.map((p) => p.slice(uiSrc.length + 1)), []);
});
