// A firmware upgrade on the devices: the device's own script under plain sh
// (RAM refused before anything else, the image checked on the device and
// removed on any failure), and the run over stand-in devices (one at a time,
// the router last, stopping at the first failure, each back on its new
// release before the next). ASU is a stand-in; no device is touched.
import test from "ava";
import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { FirmwareStep } from "../../applyEvents";
import { ImagePlan } from "../../firmware/builds";
import { requestImages, Requested, upgradeEach, UpgradeDeps } from "../../firmware/upgrade";
import { upgradeScript } from "../../firmware/upgradeScript";
import { nodePlatform } from "../../platforms/node";
import { err, ok } from "../../result";
import { fakeUpgradeDevice, virtualClock } from "../helpers/fakeDevice";
import { tempDir } from "../helpers/tempDir";
import { sampleIntentText } from "../helpers/fixtures";
import { finishSelfUpgrade, networkSettled, networkWaitMs, noteUpgrading } from "../../firmware/self";
import { jobPaths } from "../../apply/job";

/** A device's root and its tools, as the script finds them: each tool a stub that logs its arguments. */
const device = ({ freeKb = 400_000, memKb = 300_000, image = "image bytes" } = {}) => {
  const base = tempDir("upgrade");
  const [bin, tmp, root] = ["bin", "tmp", "root"].map((d) => join(base, d));
  [bin, tmp, join(root, "proc")].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(join(root, "proc", "meminfo"), `MemTotal: 1000000 kB\nMemAvailable: ${memKb} kB\n`);
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${base}/log"\n${body}\n`, { mode: 0o755 });
  stub("df", `echo "Filesystem 1K-blocks Used Available Use% Mounted"; echo "tmpfs 500000 0 ${freeKb} 0% /tmp"`);
  stub("uclient-fetch", `printf '%s' '${image}' > "$5"`);
  stub("sysupgrade", `[ "$1" = -T ] && exit "\${CHECK_FAILS:-0}"; exit 0`);
  stub("setsid", `"$@"`);
  // The device's busybox sha256sum, from whichever the host has (macOS: shasum).
  stub("sha256sum", `if [ -x /usr/bin/shasum ]; then /usr/bin/shasum -a 256 "$1"; else /usr/bin/sha256sum "$1"; fi`);
  const script = join(tmp, "onc-upgrade-r1.sh");
  writeFileSync(script, upgradeScript);
  const run = (verb: string, { stdin = "", env = {} }: { stdin?: string; env?: Record<string, string> } = {}) =>
    spawnSync("sh", [script, ...verb.split(" ")], {
      input: stdin,
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, ONC_ROOT: root, ONC_TMP: tmp, ...env },
    });
  const imagePath = join(tmp, "onc-firmware-r1.bin");
  const log = () => (existsSync(join(base, "log")) ? readFileSync(join(base, "log"), "utf8") : "");
  return { run, imagePath, log, script, root, tmp, bin, sha: createHash("sha256").update(image).digest("hex") };
};

const url = "https://sysupgrade.openwrt.org/store/abc/openwrt-sysupgrade.bin";

test("room: the less of /tmp's free space and the memory available must hold the image and sysupgrade's own", (t) => {
  const roomy = device();
  t.is(roomy.run("room 20000").stdout.trim(), "ONC_ROOM");
  // /tmp says 400 MB free, but memory has 30 MB: tmpfs takes its pages from memory.
  const tight = device({ memKb: 30_000 });
  const refused = tight.run("room 20000");
  t.is(refused.status, 1);
  t.regex(refused.stderr, /30000 KiB of RAM free; the image and sysupgrade need 36384 KiB/);
  t.notRegex(tight.log(), /uclient-fetch/, "refused before anything is downloaded");
});

test("fetch: into RAM and checked on the device; a wrong sha256 leaves no image", (t) => {
  const d = device();
  const fetched = d.run("fetch", { stdin: `${url}\n${d.sha}\n` });
  t.is(fetched.stdout.trim(), "ONC_FETCHED", fetched.stderr);
  t.regex(d.log(), new RegExp(`uclient-fetch -q -T 60 -O ${d.imagePath} ${url}`));
  const wrong = d.run("fetch", { stdin: `${url}\n${"0".repeat(64)}\n` });
  t.is(wrong.status, 1);
  t.regex(wrong.stderr, /the image's sha256 is [0-9a-f]{64}, not 0{64}/);
  t.false(existsSync(d.imagePath));
});

test("check and flash: an image sysupgrade refuses is removed; a good one is flashed keeping the settings", (t) => {
  const d = device();
  writeFileSync(d.imagePath, "image bytes");
  const refused = d.run("check", { env: { CHECK_FAILS: "1" } });
  t.is(refused.status, 1);
  t.regex(refused.stderr, /sysupgrade refuses the image for this board/);
  t.false(existsSync(d.imagePath));
  writeFileSync(d.imagePath, "image bytes");
  t.is(d.run("check").stdout.trim(), "ONC_CHECKED");
  t.is(d.run("flash").stdout.trim(), "ONC_FLASHING");
  // sysupgrade runs a moment after the answer, detached: wait for it.
  spawnSync("sleep", ["2"]);
  t.regex(d.log(), new RegExp(`^sysupgrade ${d.imagePath}$`, "m"), "no -n: the settings are kept");
  // Marked as this app's settings, kept through the flash: the image's first-boot defaults leave them be
  // (a device applied before the marker existed, or without a confirm, had none).
  t.true(existsSync(join(d.root, "etc/onc/applied")));
  t.is(readFileSync(join(d.root, "lib/upgrade/keep.d/onc-applied"), "utf8"), "/etc/onc/applied\n");
  t.is(d.run("clean").stdout.trim(), "ONC_CLEAN");
  t.false(existsSync(d.imagePath));
  t.false(existsSync(d.script));
});

test("clean: a download still running is stopped, and what keep-self left goes", async (t) => {
  const d = device();
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  const ended = new Promise<string | null>((resolve) => sleeper.on("exit", (_code, signal) => resolve(signal)));
  writeFileSync(join(d.tmp, "onc-fetch-r1.pid"), `${sleeper.pid}\n`);
  mkdirSync(join(d.root, "etc/uci-defaults"), { recursive: true });
  mkdirSync(join(d.root, "lib/upgrade/keep.d"), { recursive: true });
  writeFileSync(join(d.root, "etc/uci-defaults/90-onc-reinstall"), "");
  writeFileSync(join(d.root, "lib/upgrade/keep.d/onc-self"), "");
  t.is(d.run("clean").stdout.trim(), "ONC_CLEAN");
  t.false(existsSync(join(d.tmp, "onc-fetch-r1.pid")));
  t.false(existsSync(join(d.root, "etc/uci-defaults/90-onc-reinstall")), "no reinstall at the next boot of this release");
  t.false(existsSync(join(d.root, "lib/upgrade/keep.d/onc-self")));
  t.is(await ended, "SIGTERM", "the download stopped");
});

test("fetch: the download's pid is kept while it runs, and gone after", (t) => {
  const d = device();
  writeFileSync(join(d.bin, "uclient-fetch"), `#!/bin/sh\nfor i in 1 2 3 4 5 6 7 8 9 10; do [ -f "${d.tmp}/onc-fetch-r1.pid" ] && { echo seen > "${d.tmp}/seen"; break; }; sleep 0.1; done\nprintf '%s' 'image bytes' > "$5"\n`, { mode: 0o755 });
  t.is(d.run("fetch", { stdin: `${url}\n${d.sha}\n` }).stdout.trim(), "ONC_FETCHED");
  t.true(existsSync(join(d.tmp, "seen")), "kept while it ran");
  t.false(existsSync(join(d.tmp, "onc-fetch-r1.pid")));
});

test("as the agent's verbs (agent/prelude.ts): out of the SSH session's cgroup, and a download that leaves a process never holds the call open", (t) => {
  const d = device();
  const cg = join(d.root, "sys/fs/cgroup");
  mkdirSync(cg, { recursive: true });
  writeFileSync(join(cg, "cgroup.procs"), "");
  t.is(d.run("room 1").stdout.trim(), "ONC_ROOM");
  t.regex(readFileSync(join(cg, "onc/cgroup.procs"), "utf8"), /^\d+\n$/, "so sysupgrade, started after, is not in dropbear's");
  // A process the download leaves behind holds what it was given: never the session's streams.
  writeFileSync(join(d.bin, "uclient-fetch"), `#!/bin/sh\nsleep 5 &\necho "fetching" >&2\nprintf '%s' 'image bytes' > "$5"\n`, { mode: 0o755 });
  const started = Date.now();
  const fetched = d.run("fetch", { stdin: `${url}\n${d.sha}\n` });
  t.is(fetched.stdout.trim(), "ONC_FETCHED");
  t.regex(fetched.stderr, /fetching/, "its words passed on once it ended");
  t.true(Date.now() - started < 4000, "answered without waiting for what it left");
});

const image: Requested = { url, sha256: "a".repeat(64), sizeKb: 20_000 };
const steps = [
  { device: "ap-1", from: "25.12.3", to: "25.12.5", image: "h1", keep: "settings" as const, host: false },
  { device: "router", from: "25.12.3", to: "25.12.5", image: "h2", keep: "settings" as const, host: false },
];

/** The run's dependencies over stand-in devices, with what it reported. */
const depsFor = (devices: Record<string, ReturnType<typeof fakeUpgradeDevice>>) => {
  const clock = virtualClock();
  const reported: string[] = [];
  const deps: UpgradeDeps = {
    onDevice: async (name, _timeoutMs, work) =>
      devices[name] ? ok(await work(devices[name].session)) : err({ kind: "unreachable", message: "no route" }),
    sleep: clock.sleep,
    now: clock.now,
    report: (name: string, step: FirmwareStep) => reported.push(`${name} ${step}`),
    log: () => {},
  };
  return { deps, reported };
};

test("one device at a time, the router last, each back on its release before the next", async (t) => {
  const devices = {
    "ap-1": fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5" }),
    router: fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5" }),
  };
  const { deps, reported } = depsFor(devices);
  const run = await upgradeEach({ steps, images: { h1: image, h2: image }, runId: "r1", deps });
  t.deepEqual(run, { upgraded: ["ap-1", "router"] });
  t.deepEqual(reported, [
    ...["downloading", "checking", "flashing", "rebooting", "upgraded"].map((s) => `ap-1 ${s}`),
    ...["downloading", "checking", "flashing", "rebooting", "upgraded"].map((s) => `router ${s}`),
  ]);
});

test("too little RAM is refused before the device is touched, and nothing after it is", async (t) => {
  const devices = {
    "ap-1": fakeUpgradeDevice({ release: "25.12.3", freeKb: 24_000, comesBackOn: "25.12.5" }),
    router: fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5" }),
  };
  const { deps } = depsFor(devices);
  const run = await upgradeEach({ steps, images: { h1: image, h2: image }, runId: "r1", deps });
  t.deepEqual(run.upgraded, []);
  t.regex(run.problem!.message, /^ap-1: not enough RAM: 24000 KiB of RAM free; the image and sysupgrade need 36384 KiB\. Nothing after it was touched\.$/);
  t.deepEqual(devices["ap-1"].state.verbs, ["room", "clean"], "no download: refused first, its script removed");
  t.deepEqual(devices.router.state.verbs, []);
});

test("a failed download or check removes the device's copy and stops the run; those done before stay upgraded", async (t) => {
  for (const failing of [{ fetchFails: true }, { checkFails: true }]) {
    const devices = {
      "ap-1": fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5" }),
      router: fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5", ...failing }),
    };
    const { deps, reported } = depsFor(devices);
    const run = await upgradeEach({ steps, images: { h1: image, h2: image }, runId: "r1", deps });
    t.deepEqual(run.upgraded, ["ap-1"]);
    t.regex(run.problem!.message, /Upgraded before it: ap-1 \(settings kept\)\./);
    t.false(devices.router.state.image, "its copy of the image removed");
    t.false(devices.router.state.script);
    t.is(devices.router.release(), "25.12.3", "never flashed");
    t.is(reported[reported.length - 1], "router failed");
  }
});

test("a device that does not come back on its new release stops the run", async (t) => {
  const devices = {
    "ap-1": fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.3" }),
    router: fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5" }),
  };
  const { deps } = depsFor(devices);
  const run = await upgradeEach({ steps, images: { h1: image, h2: image }, runId: "r1", deps });
  t.regex(run.problem!.message, /^ap-1: it came back on 25\.12\.3, not 25\.12\.5\./);
  t.deepEqual(devices.router.state.verbs, []);
});

test("every image is requested before any flash; one ASU cannot build stops it all, said per build", async (t) => {
  const images: ImagePlan[] = [
    { hash: "h1", version: "25.12.5", board: "friendlyarm,nanopi-r6s", target: "rockchip/armv8", role: "router", packages: [], defaults: "", devices: ["router"] },
    { hash: "h2", version: "25.12.5", board: "zyxel,nwa50ax-pro", target: "mediatek/filogic", role: "access-point", packages: [], defaults: "", devices: ["ap-1", "ap-2"] },
  ];
  const platform = {
    ...nodePlatform,
    sleep: async () => {},
    http: {
      ...nodePlatform.http,
      request: async ({ method, url: asked }: { method: string; url: string; json?: unknown }) => {
        const answer = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
        if (asked.endsWith("/profiles.json")) {
          return answer(200, { profiles: { "friendlyarm_nanopi-r6s": { supported_devices: ["friendlyarm,nanopi-r6s"] }, "zyxel_nwa50ax-pro": { supported_devices: ["zyxel,nwa50ax-pro"] } } });
        }
        if (method === "POST") return answer(202, { request_hash: "x" });
        return answer(200, { bin_dir: "abc", images: [{ name: "r6s-sysupgrade.img.gz", sha256: "b".repeat(64), type: "sysupgrade", size: 30_000_000 }] });
      },
    },
  };
  const both = await requestImages(images, platform);
  t.true(both.ok);
  t.deepEqual(both.ok && both.value.h1, { url: "https://sysupgrade.openwrt.org/store/abc/r6s-sysupgrade.img.gz", sha256: "b".repeat(64), sizeKb: 29297 });
  const failing = await requestImages(images, {
    ...platform,
    http: {
      ...platform.http,
      // ASU cannot build the router's.
      request: async (req: { method: "GET" | "POST"; url: string; json?: unknown }) =>
        req.method === "POST" && JSON.stringify(req.json).includes("nanopi")
          ? { status: 500, headers: {}, body: "package wpad-mesh-mbedtls not found" }
          : platform.http.request(req),
    },
  });
  t.false(failing.ok);
  const said = !failing.ok ? failing.error.message : "";
  t.regex(said, /^Nothing was flashed: an image could not be built\. friendlyarm,nanopi-r6s \(router\), OpenWrt 25\.12\.5: ASU build request failed: 500 package wpad-mesh-mbedtls not found$/);
});

test("keep-self: the app's own package kept, a one-shot reinstall at first boot, and its directory, feed and key in sysupgrade's keep list", (t) => {
  const d = device();
  const { root, bin } = d;
  writeFileSync(join(bin, "apk"), `#!/bin/sh\necho "apk $*" >> "${root}/../log"\n[ "$1" = fetch ] && : > "$3/openwrt-configurator-1.2.0-r1.apk"\nexit 0\n`, { mode: 0o755 });
  // The release's own feeds, and this app's beside a feed of the user's.
  mkdirSync(join(root, "etc/apk/repositories.d"), { recursive: true });
  mkdirSync(join(root, "etc/apk/keys"), { recursive: true });
  writeFileSync(join(root, "etc/apk/repositories.d/distfeeds.list"), "https://downloads.openwrt.org/releases/25.12.3/packages/aarch64_generic/base/packages.adb\n");
  writeFileSync(join(root, "etc/apk/repositories.d/customfeeds.list"), "https://jasrusable.github.io/openwrt-configurator/openwrt/packages.adb\n");
  writeFileSync(join(root, "etc/apk/repositories.d/other.list"), "https://example.org/packages.adb\n");
  writeFileSync(join(root, "etc/apk/keys/openwrt-configurator.pem"), "key");
  const kept = d.run("keep-self", { stdin: "/etc/onc\n" });
  t.is(kept.stdout.trim(), "ONC_KEPT", kept.stderr);
  t.regex(d.log(), /^apk update\napk fetch -o .*\/etc\/onc\/pkg openwrt-configurator$/m, "the index first: none is cached after a reboot");
  t.true(existsSync(join(root, "etc/onc/pkg/openwrt-configurator-1.2.0-r1.apk")));
  t.is(
    readFileSync(join(root, "lib/upgrade/keep.d/onc-self"), "utf8"),
    "/etc/onc/\n/etc/onc/pkg/\n/etc/uci-defaults/90-onc-reinstall\n/etc/apk/keys/openwrt-configurator.pem\n/etc/apk/repositories.d/customfeeds.list\n",
    "never the release's own feeds: the new release's must stand"
  );
  t.regex(readFileSync(join(root, "etc/uci-defaults/90-onc-reinstall"), "utf8"), /^apk add --allow-untrusted --repositories-file \/dev\/null \/etc\/onc\/pkg\/\*\.apk && exit 0$/m);
  // No copy to keep (the feed unreachable): refused, so the router is never flashed without a way back for the app.
  writeFileSync(join(bin, "apk"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  t.is(d.run("keep-self", { stdin: "/etc/onc\n" }).status, 1);
});

test("the reinstall at first boot: done, it goes; failing, it is logged and stays for the next boot", (t) => {
  const d = device();
  writeFileSync(join(d.bin, "apk"), `#!/bin/sh\n[ "$1" = fetch ] && : > "$3/openwrt-configurator-1.2.0-r1.apk"\nexit 0\n`, { mode: 0o755 });
  t.is(d.run("keep-self", { stdin: "/etc/onc\n" }).stdout.trim(), "ONC_KEPT");
  const reinstall = join(d.root, "etc/uci-defaults/90-onc-reinstall");
  const boot = (apkStatus: number) => {
    writeFileSync(join(d.bin, "apk"), `#!/bin/sh\necho "apk $*" >> "${d.tmp}/boot"\nexit ${apkStatus}\n`, { mode: 0o755 });
    writeFileSync(join(d.bin, "logger"), `#!/bin/sh\necho "logger $*" >> "${d.tmp}/boot"\n`, { mode: 0o755 });
    return spawnSync("sh", [reinstall], { encoding: "utf8", env: { PATH: `${d.bin}:/usr/bin:/bin` } });
  };
  t.is(boot(1).status, 1, "uci-defaults keeps a script that fails, and runs it again at the next boot");
  t.regex(readFileSync(join(d.tmp, "boot"), "utf8"), /^logger -t openwrt-configurator could not reinstall itself/m);
  t.is(boot(0).status, 0);
});

/** How the device this app runs on keeps itself: its notes, as a log. */
const keeper = () => {
  const said: string[] = [];
  return { said, self: { dir: "/etc/onc", note: (step: { to: string }) => said.push(`note ${step.to}`), forget: () => said.push("forget") } };
};
const hostStep = { ...steps[1], host: true };

test("the device this app runs on keeps itself, notes where it is going, flashes, and leaves the rest to its next start", async (t) => {
  const devices = {
    "ap-1": fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5" }),
    router: fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5", local: true }),
  };
  const { deps } = depsFor(devices);
  const kept = keeper();
  const run = await upgradeEach({ steps: [steps[0], hostStep], images: { h1: image, h2: image }, runId: "r1", deps: { ...deps, self: kept.self } });
  t.deepEqual(run, { upgraded: ["ap-1"], flashingItself: "router" });
  t.deepEqual(devices.router.state.verbs, ["room", "fetch", "check", "keep-self", "flash"]);
  t.deepEqual(kept.said, ["note 25.12.5"]);
  // A copy it could not keep: never flashed, nothing noted.
  const failing = { router: fakeUpgradeDevice({ release: "25.12.3", local: true, keepFails: true }) };
  const noCopy = keeper();
  const stopped = await upgradeEach({ steps: [hostStep], images: { h2: image }, runId: "r1", deps: { ...depsFor(failing).deps, self: noCopy.self } });
  t.regex(stopped.problem!.message, /could not keep a copy of this app's own package/);
  t.deepEqual(failing.router.state.verbs, ["room", "fetch", "check", "keep-self", "clean"]);
  t.deepEqual(noCopy.said, ["forget"]);
  // Kept and noted, then the flash refused: cleaned, and the note forgotten, so no start acts on it.
  const refusing = { router: fakeUpgradeDevice({ release: "25.12.3", local: true, flashFails: true }) };
  const noted = keeper();
  const unflashed = await upgradeEach({ steps: [hostStep], images: { h2: image }, runId: "r1", deps: { ...depsFor(refusing).deps, self: noted.self } });
  t.regex(unflashed.problem!.message, /could not mark the settings to keep/);
  t.deepEqual(refusing.router.state.verbs, ["room", "fetch", "check", "keep-self", "flash", "clean"]);
  t.deepEqual(noted.said, ["note 25.12.5", "forget"]);
});

test("a session is the one the step was planned for: this app's device only as planned, and only it", async (t) => {
  const kept = keeper();
  const unplanned = { router: fakeUpgradeDevice({ release: "25.12.3", local: true }) };
  const local = await upgradeEach({ steps: [steps[1]], images: { h2: image }, runId: "r1", deps: { ...depsFor(unplanned).deps, self: kept.self } });
  t.regex(local.problem!.message, /^router: this app runs on it, but the upgrade was not planned so/);
  t.deepEqual(unplanned.router.state.verbs, [], "nothing run on it");
  const remote = { router: fakeUpgradeDevice({ release: "25.12.3" }) };
  const planned = await upgradeEach({ steps: [hostStep], images: { h2: image }, runId: "r1", deps: { ...depsFor(remote).deps, self: kept.self } });
  t.regex(planned.problem!.message, /^router: it was planned as the device this app runs on, but is not/);
  t.deepEqual(remote.router.state.verbs, []);
});

test("what a device runs is read again before anything: one moved since it was last read is not touched", async (t) => {
  const devices = { "ap-1": fakeUpgradeDevice({ release: "26.1.0", comesBackOn: "25.12.5" }) };
  const run = await upgradeEach({ steps: [steps[0]], images: { h1: image }, runId: "r1", deps: depsFor(devices).deps });
  t.regex(run.problem!.message, /^ap-1: it runs 26\.1\.0 now, not 25\.12\.3 as last read: read it again/);
  t.deepEqual(devices["ap-1"].state.verbs, []);
  t.false(devices["ap-1"].state.script, "not even the script written");
});

test("a run stopped after a device that kept only its SSH keys says so", async (t) => {
  const devices = {
    "ap-1": fakeUpgradeDevice({ release: "26.1.0", comesBackOn: "25.12.5" }),
    router: fakeUpgradeDevice({ release: "25.12.3", checkFails: true }),
  };
  const back = { ...steps[0], from: "26.1.0", keep: "keys" as const };
  const run = await upgradeEach({ steps: [back, steps[1]], images: { h1: image, h2: image }, runId: "r1", deps: depsFor(devices).deps });
  t.deepEqual(devices["ap-1"].state.verbs, ["room", "fetch", "check", "flash-keys"]);
  t.regex(run.problem!.message, /Upgraded before it: ap-1 \(only its SSH keys kept, on first-boot settings until the apply\)\./);
});

test("at the next start: the settings the upgrade started with are applied, never ones saved since; on another release too, for those upgraded before", async (t) => {
  const dir = tempDir("self-upgrade");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  const started: string[][] = [];
  const asked: string[] = [];
  const platformOn = (version: string, interfaces = [{ up: true, pending: false }]) => ({
    ...nodePlatform,
    sleep: async () => {},
    run: async (argv: string[]) => {
      asked.push(argv.join(" "));
      const answers: Record<string, unknown> = {
        "ubus call system board": { release: { version } },
        "ubus call network.interface dump": { interface: interfaces },
      };
      const answer = answers[argv.join(" ")];
      return answer ? { stdout: JSON.stringify(answer), stderr: "", code: 0 } : { stdout: "", stderr: "", code: 1 };
    },
    selfCommand: () => ["onc"],
    spawnDetached: (argv: string[]) => (started.push(argv), 4242),
    commandLineOf: async () => undefined,
  });
  t.is(await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.5") }), undefined, "no note: nothing to finish");
  // The upgrade's job snapshot, kept through the flash; then a save made meanwhile.
  const snapshot = jobPaths(intentPath).snapshot;
  const startedWith = sampleIntentText();
  mkdirSync(join(snapshot, ".."), { recursive: true });
  writeFileSync(snapshot, startedWith, { mode: 0o600 });
  writeFileSync(intentPath, sampleIntentText().replace(/"name": "[^"]*"/, '"name": "Saved since"'), { mode: 0o600 });
  noteUpgrading(nodePlatform, intentPath, { to: "25.12.5", at: 1 });
  const back = await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.5") });
  t.true(back?.ok);
  t.regex(back!.message, /applying the settings the upgrade was started with/);
  t.is(started.length, 1);
  t.true(started[0].includes("provision") && started[0].includes(snapshot));
  t.is(readFileSync(snapshot, "utf8"), startedWith, "the job's snapshot, not the saved file");
  t.is(await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.5") }), undefined, "read once");
  t.true(asked.includes("ubus call network.interface dump"), "the network asked after first");
  noteUpgrading(nodePlatform, intentPath, { to: "25.12.5", at: 2 });
  const wrong = await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.3") });
  t.false(wrong?.ok);
  t.regex(wrong!.message, /came back on 25\.12\.3, not 25\.12\.5.*for the devices upgraded before it/);
  t.is(started.length, 2, "still applied: those upgraded before it need it");
});

test("at the next start, with the settings the upgrade started with not kept: nothing applied, and said", async (t) => {
  const dir = tempDir("self-upgrade-lost");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  noteUpgrading(nodePlatform, intentPath, { to: "25.12.5", at: 1 });
  const started: string[][] = [];
  const done = await finishSelfUpgrade({
    intentPath,
    platform: {
      ...nodePlatform,
      sleep: async () => {},
      run: async () => ({ stdout: JSON.stringify({ release: { version: "25.12.5" } }), stderr: "", code: 0 }),
      selfCommand: () => ["onc"],
      spawnDetached: (argv: string[]) => (started.push(argv), 4242),
      commandLineOf: async () => undefined,
    },
  });
  t.true(done?.ok);
  t.regex(done!.message, /apply again/);
  t.deepEqual(started, []);
});

test("flash-keys: back to an older series, sysupgrade keeps a tarball made on the device of /etc/dropbear only", (t) => {
  const d = device();
  const root = join(d.script, "..", "..", "root");
  const tmp = join(d.script, "..");
  mkdirSync(join(root, "etc", "dropbear"), { recursive: true });
  mkdirSync(join(root, "etc", "onc"), { recursive: true });
  writeFileSync(join(root, "etc", "dropbear", "dropbear_ed25519_host_key"), "host key");
  writeFileSync(join(root, "etc", "dropbear", "authorized_keys"), "ssh-ed25519 AAAA you@mac\n");
  writeFileSync(join(root, "etc", "onc", "applied"), "");
  writeFileSync(d.imagePath, "image bytes");
  // sysupgrade stands in by keeping what it was given before the run cleans up.
  writeFileSync(join(d.script, "..", "..", "bin", "sysupgrade"), `#!/bin/sh\necho "sysupgrade $*" >> "${join(tmp, "..")}/log"\n[ "$1" = -f ] && cp "$2" "${tmp}/kept.tgz"\nexit 0\n`, { mode: 0o755 });
  t.is(d.run("flash-keys").stdout.trim(), "ONC_FLASHING");
  spawnSync("sleep", ["2"]);
  t.regex(d.log(), new RegExp(`^sysupgrade -f ${tmp}/onc-keys-r1\\.tgz ${d.imagePath}$`, "m"), "made in the device's RAM, never sent");
  const listed = spawnSync("tar", ["-tzf", join(tmp, "kept.tgz")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
  t.deepEqual(listed, ["etc/dropbear/", "etc/dropbear/authorized_keys", "etc/dropbear/dropbear_ed25519_host_key"], "no applied marker: the first-boot defaults run");
  d.run("clean");
  t.false(existsSync(join(tmp, "onc-keys-r1.tgz")));
});

test("after the router's own upgrade, the apply waits for the network: an interface up and none still coming up, for at most a few minutes", async (t) => {
  t.true(networkSettled(JSON.stringify({ interface: [{ up: true, pending: false }, { up: false, pending: false }] })));
  t.false(networkSettled(JSON.stringify({ interface: [{ up: true }, { up: false, pending: true }] })), "one still coming up");
  t.false(networkSettled(JSON.stringify({ interface: [{ up: false }] })));
  t.false(networkSettled("not json"));
  // A WAN that never comes up: it waits its limit on a virtual clock, then applies anyway.
  const dir = tempDir("self-upgrade-wait");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  mkdirSync(join(jobPaths(intentPath).snapshot, ".."), { recursive: true });
  writeFileSync(jobPaths(intentPath).snapshot, sampleIntentText(), { mode: 0o600 });
  noteUpgrading(nodePlatform, intentPath, { to: "25.12.5", at: 1 });
  const clock = virtualClock();
  const from = clock.now();
  const started: string[][] = [];
  const done = await finishSelfUpgrade({
    intentPath,
    now: clock.now,
    platform: {
      ...nodePlatform,
      sleep: clock.sleep,
      run: async (argv: string[]) =>
        argv.includes("board")
          ? { stdout: JSON.stringify({ release: { version: "25.12.5" } }), stderr: "", code: 0 }
          : { stdout: JSON.stringify({ interface: [{ up: true }, { up: false, pending: true }] }), stderr: "", code: 0 },
      selfCommand: () => ["onc"],
      spawnDetached: (argv: string[]) => (started.push(argv), 4242),
      commandLineOf: async () => undefined,
    },
  });
  t.true(done?.ok);
  t.is(started.length, 1);
  t.true(clock.now() - from >= networkWaitMs);
});
