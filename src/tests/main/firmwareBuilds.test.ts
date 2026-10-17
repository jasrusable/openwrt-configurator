// Images for an upgrade: what a fresh device comes up as (per role, nothing
// per device, nothing secret, standing aside after an upgrade that kept the
// settings), one build per board, role and release, shared and kept, and an
// image that cannot be built said before anything is flashed. ASU is a stand-in.
import test from "ava";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { appliedMarker } from "../../agent/paths";
import { DeviceSchema } from "../../deviceSchema";
import { buildAll, imagePlans } from "../../firmware/builds";
import { firstBootOf, firstBootScript, missingKey } from "../../firmware/firstBoot";
import { profileFor, profilesUrl } from "../../firmware/profiles";
import { getProfileTarget } from "../../buildImage";
import { upgradePlan } from "../../firmware/upgradePlan";
import { compileIntent } from "../../intent/compile";
import { Intent } from "../../intent/schema";
import { isSecretOption } from "../../secretOptions";
import { nodePlatform } from "../../platforms/node";
import { Plan } from "../../plan/types";
import { capturedBoards } from "../helpers/capturedBoards";
import { sampleIntent } from "../helpers/fixtures";
import { generateIntents } from "../helpers/intentGenerator";
import { tempDir } from "../helpers/tempDir";

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7cL9mXJ8uH2n0u5bq1nE2b6p0Gx3m5qS1qR8u0Vtq you@mac";
const board = (name: string, target: string): DeviceSchema => ({ ...capturedBoards().find((b) => b.schema.name === name)!.schema, target });
const router = board("friendlyarm,nanopi-r6s", "rockchip/armv8");
const ap = { ...board("zyxel,nwa50ax-pro", "mediatek/filogic"), version: "25.12.3" };

/** The sample with a second access point like the first, and an authorized key. */
const network = (): Intent => {
  const intent = sampleIntent();
  return {
    ...intent,
    system: { ...intent.system, ssh: { authorized_keys: [key], password_login: false } },
    hardware: [...intent.hardware, { ...intent.hardware[1], name: "home-ap-2" }],
  };
};
const facts = { "home-router": { ...router, version: "25.12.3" }, "home-ap-1": ap, "home-ap-2": ap };
const releases = { at: 1, series: { "25.12": ["25.12.5", "25.12.4", "25.12.3"] } };
const sha256 = nodePlatform.sha256;

test("a fresh router comes up on the main network with its pool; an access point as a DHCP client, every port bridged, serving nothing", (t) => {
  const intent = network();
  const routerScript = firstBootScript(firstBootOf(intent, "router"));
  t.regex(routerScript, /uci -q set network\.lan\.ipaddr='10\.0\.0\.1'/);
  t.regex(routerScript, /uci -q set dhcp\.lan\.start='5'/);
  t.regex(routerScript, /uci -q set dhcp\.lan\.limit='250'/);
  t.notRegex(routerScript, /proto/, "WAN stays OpenWrt's DHCP client");
  const apScript = firstBootScript(firstBootOf(intent, "access-point"));
  t.regex(apScript, /uci -q set network\.lan\.proto='dhcp'/);
  t.regex(apScript, /uci -q set dhcp\.lan\.ignore='1'/);
  t.regex(apScript, /add_list "network\.\$br\.ports=\$wan"/);
  t.regex(apScript, /network\.\$br\.stp=1/);
  t.notRegex(apScript, /10\.0\.0\./);
  for (const script of [routerScript, apScript]) {
    t.true(script.includes(key), "the authorized keys, so the app can reach it");
    t.regex(script, /PasswordAuth='off'/);
    t.regex(script, new RegExp(`\\[ -f ${appliedMarker} \\] && exit 0`), "an upgrade that kept the settings leaves them");
    t.notRegex(script, /home-router|home-ap/, "nothing per device");
  }
});

test("no image without this app's own key authorized: a device fresh from one lets in only those keys", (t) => {
  const intent = sampleIntent();
  t.regex(missingKey(intent, key)!, /^Add an SSH key first \(System › General › Authorized keys\)/);
  t.is(missingKey(network(), key), undefined);
  t.is(missingKey(network(), `${key.split(" ").slice(0, 2).join(" ")} another-comment`), undefined, "the same key, whatever its comment");
  // The app logs in with another key, or one it cannot read: it would be locked out of a device fresh from an image.
  const other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOther1 app@router";
  t.regex(missingKey(network(), other)!, /^Add this app's own key to the authorized keys/);
  t.regex(missingKey(network(), undefined)!, /^Give this app an SSH key it can read \(System › Administration › SSH key\)/);
  const { images, unbuildable } = imagePlans({ intent, plan: compileIntent(intent), facts, versions: { "home-router": "25.12.5" }, sha256, appKey: key });
  t.deepEqual(images, []);
  t.deepEqual(unbuildable, [{ device: "home-router", why: missingKey(intent, key)! }]);
  t.deepEqual(
    imagePlans({ intent: network(), plan: compileIntent(network()), facts, versions: { "home-router": "25.12.5" }, sha256, appKey: other }).unbuildable.map((u) => u.device),
    ["home-router"]
  );
});

test("a device the settings compile none of gets no image, rather than one without its role's packages", (t) => {
  const intent = network();
  const plan = compileIntent(intent);
  const without = { ...plan, devices: plan.devices.filter((d) => d.hostname !== "home-ap-2") };
  const { images, unbuildable } = imagePlans({ intent, plan: without, facts, versions: { "home-ap-1": "25.12.5", "home-ap-2": "25.12.5" }, sha256, appKey: key });
  t.deepEqual(images.flatMap((i) => i.devices), ["home-ap-1"]);
  t.deepEqual(unbuildable, [{ device: "home-ap-2", why: "The settings compile no such device: its packages are not known." }]);
});

/** A root a first-boot script runs in: uci as a log of what it was asked, passwd of what it read. */
const runFirstBoot = (script: string, { applied = false } = {}) => {
  const root = tempDir("firstboot");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "etc", "onc"), { recursive: true });
  if (applied) writeFileSync(join(root, "etc", "onc", "applied"), "");
  writeFileSync(
    join(bin, "uci"),
    `#!/bin/sh\necho "$*" >> "${root}/uci.log"\ncase "$*" in "-q show network") echo "network.@device[0].name='br-lan'" ;; "-q get network.wan.device") echo wan ;; esac\n`,
    { mode: 0o755 }
  );
  writeFileSync(join(bin, "passwd"), `#!/bin/sh\necho "$*" >> "${root}/passwd.log"\ncat >> "${root}/passwd.log"\n`, { mode: 0o755 });
  // Paths on the device, under this root.
  const rooted = script.replace(/\/etc\//g, `${root}/etc/`);
  const ran = spawnSync("sh", ["-c", rooted], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
  const log = (() => {
    try {
      return readFileSync(join(root, "uci.log"), "utf8");
    } catch {
      return "";
    }
  })();
  const passwd = (() => {
    try {
      return readFileSync(join(root, "passwd.log"), "utf8");
    } catch {
      return "";
    }
  })();
  return { ran, log, root, passwd };
};

test("under plain sh: fresh, the access point's script bridges the WAN port and installs the keys; after a kept upgrade, it does nothing", (t) => {
  const script = firstBootScript(firstBootOf(network(), "access-point"));
  const fresh = runFirstBoot(script);
  t.is(fresh.ran.status, 0, fresh.ran.stderr);
  t.regex(fresh.log, /^-q add_list network\.@device\[0\]\.ports=wan$/m);
  t.regex(fresh.log, /^-q set network\.@device\[0\]\.stp=1$/m);
  t.regex(fresh.log, /^commit$/m);
  t.is(readFileSync(join(fresh.root, "etc", "dropbear", "authorized_keys"), "utf8"), `${key}\n`);
  // Root a password no one knows: with none, LuCI would let anyone in.
  const [user, password, again] = fresh.passwd.split("\n");
  t.is(user, "root");
  t.regex(password, /^[A-Za-z0-9]{32}$/);
  t.is(again, password);
  t.not(runFirstBoot(script).passwd.split("\n")[1], password, "made on each device, never in the image");
  const kept = runFirstBoot(script, { applied: true });
  t.is(kept.ran.status, 0);
  t.is(kept.log, "");
  t.is(kept.passwd, "", "an upgrade that kept the settings keeps root's password");
});

/** Every value the compiled plan or the intent holds as a secret. */
const secretsOf = (intent: Intent, plan: Plan) => {
  const fromOptions = Object.values(plan.config).flatMap((types) =>
    Object.values(types).flatMap((sections) =>
      sections.flatMap((s) => [s.options, ...(s.overrides ?? []).map((o) => o.options)]).flatMap((options) =>
        Object.entries(options ?? {}).flatMap(([option, value]) =>
          isSecretOption(option) ? [value].flat().filter((v): v is string => typeof v === "string") : []
        )
      )
    )
  );
  // Owner-only files, but for the authorized keys: public, and put in on purpose.
  const fromFiles = plan.files
    .filter((f) => f.mode && /0?[0-7]00$/.test(f.mode) && f.path !== "/etc/dropbear/authorized_keys")
    .map((f) => f.content);
  return [...fromOptions, ...fromFiles, intent.system.app_login.password ?? ""].filter((v) => v.length >= 6);
};

test("no secret of any generated network reaches a first-boot script or a build request", (t) => {
  // Each with a key, as every image needs one.
  const intents = generateIntents(Number(process.env.ONC_GEN_CASES ?? 40), 7).map((intent) => ({
    ...intent,
    system: { ...intent.system, ssh: { ...intent.system.ssh, authorized_keys: [key] } },
  }));
  const checked = intents.map((intent) => {
    const plan = compileIntent(intent);
    const versions = Object.fromEntries(intent.hardware.map((d) => [d.name, "25.12.5"]));
    const facts = Object.fromEntries(intent.hardware.map((d) => [d.name, d.role === "router" ? router : ap]));
    const { images } = imagePlans({ intent, plan, facts, versions, sha256, appKey: key });
    const requests = images.map(({ version, target, board, packages, defaults }) => JSON.stringify({ version, target, board, packages, defaults }));
    const secrets = secretsOf(intent, plan);
    return { leaked: secrets.filter((s) => requests.some((r) => r.includes(s) || r.includes(JSON.stringify(s).slice(1, -1)))), secrets: secrets.length };
  });
  t.deepEqual(checked.flatMap((c) => c.leaked), []);
  t.true(checked.some((c) => c.secrets > 0), "the networks do hold secrets");
});

test("one image per board, role and release: identical access points share one build", (t) => {
  const intent = network();
  const plan = compileIntent(intent);
  const { images, unbuildable } = imagePlans({
    intent,
    plan,
    facts: { ...facts, "home-ap-3": undefined },
    versions: { "home-router": "25.12.5", "home-ap-1": "25.12.5", "home-ap-2": "25.12.5", "home-ap-3": "25.12.5" },
    sha256,
    appKey: key,
  });
  t.deepEqual(
    images.map((i) => [i.board, i.role, i.devices]),
    [
      ["friendlyarm,nanopi-r6s", "router", ["home-router"]],
      ["zyxel,nwa50ax-pro", "access-point", ["home-ap-1", "home-ap-2"]],
    ]
  );
  t.deepEqual(unbuildable.map((u) => u.device), ["home-ap-3"]);
  // The role's packages, as an apply leaves them: an access point serves no DHCP.
  t.true(images[1].packages.includes("-dnsmasq") || !images[0].packages.includes("-dnsmasq"));
});

test("an upgrade moves the devices behind, access points first and the router last, and says why the others stay", (t) => {
  const intent = network();
  const plan = compileIntent(intent);
  const held = { ...intent, hardware: intent.hardware.map((d) => (d.name === "home-ap-2" ? { ...d, firmware: "hold" as const } : d)) };
  const upgrade = upgradePlan({ intent: held, plan, facts, releases, sha256, appKey: key });
  t.deepEqual(
    upgrade.steps.map((s) => [s.device, s.from, s.to]),
    [
      ["home-ap-1", "25.12.3", "25.12.5"],
      ["home-router", "25.12.3", "25.12.5"],
    ]
  );
  t.deepEqual(upgrade.staying, [{ device: "home-ap-2", why: "Held." }]);
  t.deepEqual(upgradePlan({ intent, plan, facts, releases, only: ["home-ap-2"], sha256, appKey: key }).steps.map((s) => s.device), ["home-ap-2"]);
});

test("a board's profile is the one that lists it, else the board's own name", (t) => {
  const profiles = { "linksys_e8450-ubi": ["linksys,e8450-ubi"], "glinet_gl-mt6000": ["glinet,gl-mt6000"], "x_y": [] };
  t.is(profileFor(profiles, "linksys,e8450-ubi"), "linksys_e8450-ubi");
  t.is(profileFor(profiles, "x,y"), "x_y");
  t.is(profileFor(profiles, "nobody,here"), undefined);
});

test("a low-level config's board finds its profile as an intent's does: by the boards each profile lists", async (t) => {
  const version = "24.10.97";
  const asked: string[] = [];
  const platform = {
    sleep: async () => {},
    http: {
      ...nodePlatform.http,
      request: async ({ url }: { url: string }) => {
        asked.push(url);
        const body = url.endsWith(".overview.json")
          ? { profiles: [{ id: "linksys_e8450", target: "mediatek/mt7622" }, { id: "linksys_e8450-ubi", target: "mediatek/mt7622" }, { id: "other", target: "x86/64" }] }
          : { profiles: { linksys_e8450: { supported_devices: ["linksys,e8450"] }, "linksys_e8450-ubi": { supported_devices: ["linksys,e8450-ubi"] } } };
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      },
    },
  };
  t.deepEqual(await getProfileTarget({ version, modelId: "linksys,e8450-ubi", platform }), { profile: "linksys_e8450-ubi", target: "mediatek/mt7622" });
  t.true(asked.includes(profilesUrl(version, "mediatek/mt7622")), "the target's own list of boards decides");
  await t.throwsAsync(getProfileTarget({ version, modelId: "nobody,here", platform }), { message: /No profile for nobody,here/ });
});

/** ASU, as a stand-in: profiles, a build queued then done, the image; a board it cannot build fails. */
const fakeAsu = () => {
  const asked: string[] = [];
  // gzip's magic first, as a sysupgrade image starts.
  const image = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("image")]);
  const imageSha = createHash("sha256").update(image).digest("hex");
  const platform = {
    ...nodePlatform,
    sleep: async () => {},
    http: {
      request: async ({ method, url, json }: { method: string; url: string; json?: unknown }) => {
        asked.push(`${method} ${url}`);
        const answer = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
        if (url.endsWith("/profiles.json")) {
          return url.includes("rockchip")
            ? answer(200, { profiles: { "friendlyarm_nanopi-r6s": { supported_devices: ["friendlyarm,nanopi-r6s"] } } })
            : answer(404, {});
        }
        if (method === "POST") return answer(202, { request_hash: `h-${(json as { profile: string }).profile}` });
        return answer(200, { bin_dir: "abc", images: [{ name: "r6s-squashfs-sysupgrade.img.gz", sha256: imageSha, type: "sysupgrade", size: image.length }] });
      },
      download: async (_url: string, path: string) => {
        asked.push("download");
        writeFileSync(path, image);
        return { bytes: image.length, contentLength: image.length };
      },
    },
  };
  return { platform, asked };
};

test("builds run once and are kept by what went into them; one that cannot be built is said, per build", async (t) => {
  const intentPath = join(tempDir("firmware-builds"), "intent.json");
  const intent = network();
  const { images } = imagePlans({ intent, plan: compileIntent(intent), facts, versions: { "home-router": "25.12.5", "home-ap-1": "25.12.5" }, sha256, appKey: key });
  const { platform, asked } = fakeAsu();
  const first = await buildAll({ intentPath, images, platform });
  t.true("built" in first[0]);
  t.regex("error" in first[1] ? first[1].error : "", /OpenWrt 25\.12\.5 has no mediatek\/filogic target \(404\)/);
  t.is(asked.filter((a) => a === "download").length, 1);
  // Again: the kept image is whole, so nothing is asked of ASU for it.
  asked.length = 0;
  const again = await buildAll({ intentPath, images: [images[0]], platform });
  t.true("built" in again[0]);
  t.deepEqual(asked, []);
});

test("the device this app runs on is flashed last, its image with what the app runs with", (t) => {
  const intent = network();
  const plan = compileIntent(intent);
  const upgrade = upgradePlan({ intent, plan, facts, releases, sha256, appKey: key, host: "home-ap-1" });
  t.deepEqual(upgrade.steps.map((s) => [s.device, s.host]), [["home-ap-2", false], ["home-router", false], ["home-ap-1", true]]);
  const own = upgrade.images.find((i) => i.devices.includes("home-ap-1"))!;
  t.true(own.packages.includes("quickjs") && own.packages.includes("uhttpd"));
  t.deepEqual(own.devices, ["home-ap-1"], "its image is its own: the other access point's lacks the runtime");
});

test("a downgrade within a series keeps the settings; one to an older series keeps only the SSH keys; both are listed to acknowledge", (t) => {
  const intent = network();
  const plan = compileIntent(intent);
  const pinned = (version: string): Intent => ({ ...intent, hardware: intent.hardware.map((d) => (d.name === "home-ap-1" ? { ...d, firmware: version } : d)) });
  const out = { at: 1, series: { "25.12": ["25.12.5", "25.12.3"], "26.1": ["26.1.0"] } };
  const within = upgradePlan({ intent: pinned("25.12.3"), plan, facts: { ...facts, "home-ap-1": { ...ap, version: "25.12.5" } }, releases: out, only: ["home-ap-1"], sha256, appKey: key });
  t.like(within.steps[0], { device: "home-ap-1", from: "25.12.5", to: "25.12.3", keep: "settings" });
  t.deepEqual(within.downgrades.map((s) => s.device), ["home-ap-1"]);
  const across = upgradePlan({ intent: pinned("25.12.5"), plan, facts: { ...facts, "home-ap-1": { ...ap, version: "26.1.0" } }, releases: out, only: ["home-ap-1"], sha256, appKey: key });
  t.like(across.steps[0], { from: "26.1.0", to: "25.12.5", keep: "keys" });
  t.deepEqual(across.refused, []);
  // An upgrade is none of these.
  const up = upgradePlan({ intent, plan, facts, releases: out, only: ["home-ap-1"], sha256, appKey: key });
  t.like(up.steps[0], { keep: "settings" });
  t.deepEqual(up.downgrades, []);
});

test("back to an older series is refused where first-boot settings would strand something: this app's device, a mesh repeater, the access point this machine is on", (t) => {
  const intent = network();
  const plan = compileIntent(intent);
  const out = { at: 1, series: { "25.12": ["25.12.5"], "26.1": ["26.1.0"] } };
  const back = (changed: Intent, more: { host?: string; viaWifi?: string[] } = {}) =>
    upgradePlan({
      intent: { ...changed, hardware: changed.hardware.map((d) => (d.name === "home-ap-1" ? { ...d, firmware: "25.12.5" } : d)) },
      plan,
      facts: { ...facts, "home-ap-1": { ...ap, version: "26.1.0" } },
      releases: out,
      only: ["home-ap-1"],
      sha256,
      appKey: key,
      ...more,
    });
  const host = back(intent, { host: "home-ap-1" });
  t.like(host.steps[0], { keep: "keys", host: true });
  t.regex(host.refused[0].why, /^This app runs on it: back to an older series it comes up on first-boot settings, keeping only its SSH keys/);
  const mesh = back({ ...intent, hardware: intent.hardware.map((d) => (d.name === "home-ap-1" ? { ...d, uplink: "mesh" as const } : d)) });
  t.regex(mesh.refused[0].why, /^It reaches the network over the mesh/);
  const wifi = back(intent, { viaWifi: ["home-ap-1"] });
  t.regex(wifi.refused[0].why, /^This machine reaches the network through its Wi-Fi/);
  t.deepEqual(back(intent, { viaWifi: ["home-ap-2"] }).refused, [], "another access point's Wi-Fi is no matter");
  // A cabled node mesh repeaters may reach the network through: with no mesh after, they are cut off.
  const meshed = (intentIn: Intent, meshOn = true): Intent => ({
    ...intentIn,
    wifi: { ...intentIn.wifi, mesh: { ...intentIn.wifi.mesh, enabled: meshOn } },
    hardware: intentIn.hardware.map((d) => (d.name === "home-ap-2" ? { ...d, uplink: "mesh" as const } : d)),
  });
  t.regex(back(meshed(intent)).refused[0]?.why ?? "", /^The mesh repeaters \(home-ap-2\) may reach the network through it/);
  t.deepEqual(back(meshed(intent, false)).refused, [], "no mesh on: nothing reaches anything through it");

  const within = upgradePlan({ intent, plan, facts, releases, only: ["home-ap-1"], sha256, appKey: key, host: "home-ap-1", viaWifi: ["home-ap-1"] });
  t.deepEqual(within.refused, []);
});
