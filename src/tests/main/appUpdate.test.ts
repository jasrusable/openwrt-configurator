import test from "ava";
import { writeFileSync } from "fs";
import { join } from "path";
import { appUpdate, appVersions, parsePolicy, refreshAppIndex, startAppUpdate, updateScript } from "../../appUpdate";
import { nodePlatform } from "../../platforms/node";
import { tempDir } from "../helpers/tempDir";

// As apk-tools 3.0.5 prints it on 25.12.6: a dev build installed, the feed's release offered.
const policy = (offered: string[], installed = "0.1.4_p20261115141300-r1") =>
  [
    "openwrt-configurator policy:",
    ...offered.flatMap((v) => [`  ${v}:`, "    https://jasrusable.github.io/openwrt-configurator/openwrt/packages.adb"]),
    `  ${installed}:`,
    "    lib/apk/db/installed",
    "",
  ].join("\n");

/** apk's order, for these versions: the release, the dev build, the next release. */
const order = ["0.1.4-r1", "0.1.4_p20261115141300-r1", "0.1.5-r1", "0.1.6-r1"];

const fakeApk = (offered: string[], calls: string[][] = []) => async (argv: string[]) => {
  calls.push(argv);
  if (argv[0] !== "apk") throw new Error("not here");
  if (argv[1] === "policy") return { code: 0, stdout: policy(offered), stderr: "" };
  if (argv[1] === "version") return { code: 0, stdout: order.indexOf(argv[3]) > order.indexOf(argv[4]) ? ">\n" : "<\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

test("apk's policy is read as the version installed and those offered", (t) => {
  t.deepEqual(parsePolicy(policy(["0.1.4-r1"])), [
    { version: "0.1.4-r1", installed: false },
    { version: "0.1.4_p20261115141300-r1", installed: true },
  ]);
});

test("only a version apk orders after the installed one is offered, the newest of them", async (t) => {
  t.deepEqual(await appVersions({ run: fakeApk(["0.1.4-r1"]) }), { installed: "0.1.4_p20261115141300-r1" }, "a dev build is newer than its release");
  t.deepEqual(await appVersions({ run: fakeApk(["0.1.5-r1", "0.1.6-r1", "0.1.4-r1"]) }), {
    installed: "0.1.4_p20261115141300-r1",
    available: "0.1.6-r1",
  });
  t.is(await appVersions({ run: async () => Promise.reject(new Error("ENOENT")) }), undefined, "no apk: not a router");
});

const setup = (offered: string[]) => {
  const intentPath = join(tempDir("app-update"), "intent.json");
  writeFileSync(intentPath, "{}");
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const platform = {
    ...nodePlatform,
    run: fakeApk(offered, calls),
    spawnDetached: (argv: string[]) => {
      spawned.push(argv);
      return 4242;
    },
  };
  return { intentPath, platform, calls, spawned };
};

test("an update runs detached: the package, the collector restarted, its status left for the page", async (t) => {
  const { intentPath, platform, spawned } = setup(["0.1.5-r1"]);
  const started = await startAppUpdate({ intentPath, platform, now: () => 1000 });
  t.deepEqual(started, { started: { at: 1000, from: "0.1.4_p20261115141300-r1", to: "0.1.5-r1", pid: 4242 } });
  t.deepEqual(spawned, [["sh", "-c", updateScript(intentPath)]]);
  t.regex(updateScript(intentPath), /apk add --upgrade 'openwrt-configurator'[\s\S]*onc-collector restart[\s\S]*app-update\.exit/);
  t.true((await appUpdate({ intentPath, platform, now: () => 2000 }))?.run?.running);
  t.deepEqual(await startAppUpdate({ intentPath, platform, now: () => 2000 }), { refused: "An update is already running." });
  writeFileSync(`${intentPath}.state/app-update.exit`, "0");
  const ended = (await appUpdate({ intentPath, platform, now: () => 3000 }))?.run;
  t.false(ended?.running);
  t.true(ended?.done?.ok);
});

test("an update is refused with nothing newer, and a run that never ended is taken as failed", async (t) => {
  const none = setup(["0.1.4-r1"]);
  t.deepEqual(await startAppUpdate({ intentPath: none.intentPath, platform: none.platform }), { refused: "This is the newest version." });
  t.deepEqual(none.spawned, []);
  const { intentPath, platform } = setup(["0.1.5-r1"]);
  await startAppUpdate({ intentPath, platform, now: () => 0 });
  const stale = (await appUpdate({ intentPath, platform, now: () => 11 * 60_000 }))?.run;
  t.false(stale?.running);
  t.false(stale?.done?.ok);
});

test("the feeds' index is fetched at most once a day, and only where apk knows this app", async (t) => {
  const { intentPath, platform, calls } = setup(["0.1.5-r1"]);
  const fetches = () => calls.filter((c) => c[1] === "update").length;
  await refreshAppIndex({ intentPath, platform, now: () => 0 });
  await refreshAppIndex({ intentPath, platform, now: () => 3_600_000 });
  t.is(fetches(), 1);
  await refreshAppIndex({ intentPath, platform, now: () => 25 * 3_600_000 });
  t.is(fetches(), 2);
  t.is((await appUpdate({ intentPath, platform }))?.checkedAt, 25 * 3_600_000);
  const mac = { ...platform, run: async () => Promise.reject(new Error("ENOENT")) };
  await refreshAppIndex({ intentPath, platform: mac, maxAgeMs: 0 });
  t.is(await appUpdate({ intentPath, platform: mac }), undefined);
});
