// What is kept beside an intent is its owner's alone: the files are 0600, and
// the directories that name them (which devices there are, their runs) 0700.
import test from "ava";
import { mkdirSync, statSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { nodePlatform } from "../../platforms/node";
import { keepStatePrivate, stateLayout, write } from "../../store";
import { tempDir } from "../helpers/tempDir";

const modeOf = (path: string) => statSync(path).mode & 0o777;

test("the state directory is made owner-only, and one made before (0755) is tightened", (t) => {
  const dir = tempDir("state");
  const intentPath = join(dir, "intent.json");
  const { root, devices } = stateLayout(intentPath);
  write(nodePlatform, { path: join(devices, "ap.json"), schema: z.string(), format: 1 }, "x");
  t.is(modeOf(root), 0o700);
  t.is(modeOf(devices), 0o700);
  t.is(modeOf(join(devices, "ap.json")), 0o600);

  const older = join(dir, "older.json");
  mkdirSync(stateLayout(older).root, { mode: 0o755 });
  t.is(modeOf(stateLayout(older).root), 0o755);
  keepStatePrivate(nodePlatform, older);
  t.is(modeOf(stateLayout(older).root), 0o700);
});
