// A firmware upgrade on the devices: the device's own script under plain sh
// (RAM refused before anything else, the image checked on the device and
// removed on any failure), and the run over stand-in devices (one at a time,
// the router last, stopping at the first failure, each back on its new
// release before the next). ASU is a stand-in; no device is touched.
import test from "ava";
import { spawnSync } from "child_process";
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
import { finishSelfUpgrade, noteUpgrading } from "../../firmware/self";

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
  return { run, imagePath, log, script, sha: createHash("sha256").update(image).digest("hex") };
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
  t.is(d.run("clean").stdout.trim(), "ONC_CLEAN");
  t.false(existsSync(d.imagePath));
  t.false(existsSync(d.script));
});

const image: Requested = { url, sha256: "a".repeat(64), sizeKb: 20_000 };
const steps = [
  { device: "ap-1", from: "25.12.3", to: "25.12.5", image: "h1", keep: "settings" as const },
  { device: "router", from: "25.12.3", to: "25.12.5", image: "h2", keep: "settings" as const },
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
    t.regex(run.problem!.message, /ap-1 was upgraded, settings kept/);
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

test("keep-self: the app's own package kept, a one-shot reinstall at first boot, and its directory in sysupgrade's keep list", (t) => {
  const d = device();
  const root = join(d.script, "..", "..", "root");
  const bin = join(d.script, "..", "..", "bin");
  writeFileSync(join(bin, "apk"), `#!/bin/sh\necho "apk $*" >> "${root}/../log"\n[ "$1" = fetch ] && : > "$3/openwrt-configurator-1.2.0-r1.apk"\nexit 0\n`, { mode: 0o755 });
  const kept = d.run("keep-self", { stdin: "/etc/onc\n" });
  t.is(kept.stdout.trim(), "ONC_KEPT", kept.stderr);
  t.regex(d.log(), /^apk update\napk fetch -o .*\/etc\/onc\/pkg openwrt-configurator$/m, "the index first: none is cached after a reboot");
  t.true(existsSync(join(root, "etc/onc/pkg/openwrt-configurator-1.2.0-r1.apk")));
  t.is(
    readFileSync(join(root, "lib/upgrade/keep.d/onc-self"), "utf8"),
    "/etc/onc/\n/etc/onc/pkg/\n/etc/uci-defaults/90-onc-reinstall\n/etc/apk/keys/\n/etc/apk/repositories.d/\n"
  );
  t.regex(readFileSync(join(root, "etc/uci-defaults/90-onc-reinstall"), "utf8"), /^apk add --allow-untrusted --repositories-file \/dev\/null \/etc\/onc\/pkg\/\*\.apk$/m);
  // No copy to keep (the feed unreachable): refused, so the router is never flashed without a way back for the app.
  writeFileSync(join(bin, "apk"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  t.is(d.run("keep-self", { stdin: "/etc/onc\n" }).status, 1);
});

test("the device this app runs on keeps itself, notes where it is going, flashes, and leaves the rest to its next start", async (t) => {
  const devices = {
    "ap-1": fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5" }),
    router: fakeUpgradeDevice({ release: "25.12.3", comesBackOn: "25.12.5", local: true }),
  };
  const { deps } = depsFor(devices);
  const noted: string[] = [];
  const run = await upgradeEach({
    steps,
    images: { h1: image, h2: image },
    runId: "r1",
    deps: { ...deps, self: { dir: "/etc/onc", note: (step) => noted.push(step.to) } },
  });
  t.deepEqual(run, { upgraded: ["ap-1"], flashingItself: "router" });
  t.deepEqual(devices.router.state.verbs, ["room", "fetch", "check", "keep-self", "flash"]);
  t.deepEqual(noted, ["25.12.5"]);
  // A copy it could not keep: never flashed.
  const failing = { router: fakeUpgradeDevice({ release: "25.12.3", local: true, keepFails: true }) };
  const stopped = await upgradeEach({
    steps: [steps[1]],
    images: { h2: image },
    runId: "r1",
    deps: { ...depsFor(failing).deps, self: { dir: "/etc/onc", note: () => t.fail("not noted") } },
  });
  t.regex(stopped.problem!.message, /could not keep a copy of this app's own package/);
  t.deepEqual(failing.router.state.verbs, ["room", "fetch", "check", "keep-self", "clean"]);
});

test("at the next start: on the new release, the saved settings are applied; on another, said, and nothing applied", async (t) => {
  const dir = tempDir("self-upgrade");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  const started: string[][] = [];
  const platformOn = (version: string) => ({
    ...nodePlatform,
    run: async (argv: string[]) =>
      argv.join(" ") === "ubus call system board" ? { stdout: JSON.stringify({ release: { version } }), stderr: "", code: 0 } : { stdout: "", stderr: "", code: 1 },
    selfCommand: () => ["onc"],
    spawnDetached: (argv: string[]) => (started.push(argv), 4242),
    commandLineOf: async () => undefined,
  });
  t.is(await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.5") }), undefined, "no note: nothing to finish");
  noteUpgrading(nodePlatform, intentPath, { to: "25.12.5", at: 1 });
  const back = await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.5") });
  t.true(back?.ok);
  t.is(started.length, 1);
  t.true(started[0].includes("provision"));
  t.is(await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.5") }), undefined, "read once");
  noteUpgrading(nodePlatform, intentPath, { to: "25.12.5", at: 2 });
  const wrong = await finishSelfUpgrade({ intentPath, platform: platformOn("25.12.3") });
  t.false(wrong?.ok);
  t.regex(wrong!.message, /came back on 25\.12\.3, not 25\.12\.5/);
  t.is(started.length, 1, "nothing applied");
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
