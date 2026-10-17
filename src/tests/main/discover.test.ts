import test from "ava";
import { sampleIntent, sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DeviceFacts, readFacts, writeFacts } from "../../deviceFacts";
import { adopt, discoverCandidates, inspect, inspectAt, inspectReset, readopt, suggestName, suggestRole } from "../../discover";
import { Intent } from "../../intent/schema";
import { Platform, Session, SshTarget } from "../../platform";
import { nodePlatform } from "../../platforms/node";
import { parseLeases } from "../../status/device";

const sample = (): Intent =>
  sampleIntent();

const seenAp: DeviceFacts = {
  hostname: "old-ap",
  readAt: 5,
  schema: { name: "zyxel,nwa50ax-pro", model: "Zyxel NWA50AX Pro", version: "25.12.5" },
  address: "10.0.0.60",
  macs: ["aa:00:00:00:00:60"],
};

test("on the network and not in Hardware: seen before first, then likely OpenWrt, then the rest", (t) => {
  const candidates = discoverCandidates({
    leases: parseLeases(
      [
        "1 aa:00:00:00:00:01 10.0.0.2 home-ap-1 *",
        "1 aa:00:00:00:00:43 10.0.0.143 OpenWrt *",
        "1 aa:00:00:00:00:60 10.0.0.61 * *",
        "1 aa:00:00:00:00:99 10.0.0.99 phone *",
        "1 aa:00:00:00:00:50 10.0.0.50 * *",
      ].join("\n")
    ),
    neighbours: [{ address: "10.0.0.7", mac: "aa:00:00:00:00:07" }],
    banners: { "10.0.0.50": "SSH-2.0-dropbear" },
    known: { names: ["home-router", "home-ap-1"], addresses: ["10.0.0.1"], macs: [] },
    seen: [seenAp],
  });
  t.deepEqual(
    candidates.map((c) => [c.address, c.seen?.hostname ?? null, c.likelyOpenWrt]),
    [
      ["10.0.0.61", "old-ap", true],
      ["10.0.0.50", null, true],
      ["10.0.0.143", null, true],
      ["10.0.0.7", null, false],
      ["10.0.0.99", null, false],
    ],
    "home-ap-1 is already in Hardware; old-ap found by its MAC at a new address"
  );
});

test("suggested role and name", (t) => {
  t.is(suggestRole({ name: "x", version: "", radios: [{ name: "radio0", type: "mac80211", path: "p", band: "5g" }] }), "access-point");
  t.is(suggestRole({ name: "x", version: "", ports: [{ name: "eth1", default_role: "wan" }] }), "router");
  t.is(suggestName("OpenWrt", "access-point", ["ap-1"]), "ap-2");
  t.is(suggestName("Living-Room AP", "access-point", []), "living-room-ap");
  t.is(suggestName("ap-1", "access-point", ["ap-1"]), "ap-2", "a name already taken is not offered");
});

/** One stock device at 10.0.0.143: its dropbear lets root in with any password, and has no keys. */
const stock = (accepts: { key: boolean }) => {
  const knownHosts = join(tempDir("discover"), "known_hosts");
  writeFileSync(knownHosts, "");
  const targets: SshTarget[] = [];
  const session: Session = {
    execCommand: async (command: string) => {
      const answer = (part: string) =>
        part.includes("board.json")
          ? JSON.stringify({ model: { id: "zyxel,nwa50ax-pro", name: "Zyxel NWA50AX Pro" }, network: { lan: { ports: ["lan1"], protocol: "static" } } })
          : part.includes("ubus call uci get")
          ? JSON.stringify({ values: { radio0: { ".name": "radio0", ".type": "wifi-device", type: "mac80211", path: "p", channel: "auto", band: "5g" } } })
          : part.includes("ubus call system board")
          ? JSON.stringify({ board_name: "zyxel,nwa50ax-pro", model: "Zyxel NWA50AX Pro", release: { version: "25.12.5" } })
          : part.includes("hostname")
          ? "OpenWrt"
          : part.includes("/sys/class/net")
          ? "aa:00:00:00:00:43"
          : "";
      const parts = command.split(/\n\) 2>\/dev\/null; printf '\\n__ONC_PROBE__%s\\n' "\$\?"\n?/).filter((p) => p.trim());
      return { stdout: parts.map((p) => `${answer(p)}\n__ONC_PROBE__0\n`).join(""), stderr: "", code: 0 };
    },
    dispose: () => {},
  };
  const platform: Platform = {
    ...nodePlatform,
    env: (name) => (name === "ONC_KNOWN_HOSTS" ? knownHosts : undefined),
    connect: async (target) => {
      targets.push(target);
      if (target.privateKeyPath && !accepts.key) throw new Error("Permission denied (publickey)");
      // As a client trusting on first use: the key recorded where it was told to.
      appendFileSync(target.knownHostsFile ?? knownHosts, `${target.host} ssh-ed25519 ${stockKey}\n`);
      return session;
    },
  };
  return { platform, targets };
};

/** A throwaway ed25519 key's blob (see sshFingerprint.test.ts). */
const stockKey = "AAAAC3NzaC1lZDI1NTE5AAAAID5Uksu7SVbBjJHbyYQi5Ph9ttJOj9q5YIlUqopPzPZH";

test("a stock device is read with OpenWrt's default, never the admin password, and flagged as open", async (t) => {
  const intent = sample();
  intent.system = { ...intent.system, app_login: { key: "/tmp/id_test", password: "the-admin-secret" } };
  const { platform, targets } = stock({ key: false });
  const inspected = await inspect({ address: "10.0.0.143", intent, platform });
  t.true(inspected.ok);
  const read = inspected.ok ? inspected.value : undefined!;
  t.like(read, {
    address: "10.0.0.143",
    hostname: "OpenWrt",
    macs: ["aa:00:00:00:00:43"],
    hostKey: { type: "ssh-ed25519", key: stockKey },
    // As ssh-keygen -l prints it, for comparing with the device's console.
    fingerprint: "SHA256:gh/DjvamWtJ5GKvUg3A1h7FCtff7jQ+tzXzJM3F15R8",
    openLogin: true,
    suggested: { role: "access-point", name: "ap-1" },
  });
  t.is(read.schema.model, "Zyxel NWA50AX Pro");
  t.false(targets.some((target) => target.password === "the-admin-secret"), "the admin password is never sent");
  t.deepEqual(targets.map((target) => !!target.privateKeyPath), [true, false], "this app's key first");
});

test("a device that takes this app's key is not open", async (t) => {
  const intent = sample();
  intent.system = { ...intent.system, app_login: { key: "/tmp/id_test" } };
  const read = await inspect({ address: "10.0.0.143", intent, platform: stock({ key: true }).platform });
  t.like(read, { ok: true, value: { openLogin: false } });
});

/** A network with a reset device at 10.0.0.143: its old key on record there, and the router's, which stays. */
const resetNetwork = () => {
  const { platform } = stock({ key: false });
  const knownHosts = platform.env("ONC_KNOWN_HOSTS")!;
  const before = "10.0.0.143 ssh-ed25519 AAAAoldkey\n10.0.0.1 ssh-ed25519 AAAArouter\n";
  writeFileSync(knownHosts, before);
  const intentPath = join(tempDir("reset"), "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  writeFacts(platform, intentPath, {
    hostname: "home-ap-1",
    readAt: 1,
    schema: { name: "zyxel,nwa50ax-pro", version: "25.12.5" },
    address: "10.0.0.143",
    macs: ["aa:00:00:00:00:43"],
    hostKey: { type: "ssh-ed25519", key: "AAAAoldkey" },
  });
  return { platform, knownHosts, before, intentPath };
};

test("reading a reset device trusts nothing: cancelling leaves the old pin as it was", async (t) => {
  const { platform, knownHosts, before, intentPath } = resetNetwork();
  t.is((await inspectReset({ intentPath, platform, address: "10.0.0.143", name: "nobody" })).ok, false);
  const read = await inspectReset({ intentPath, platform, address: "10.0.0.143", name: "home-ap-1" });
  t.true(read.ok);
  t.truthy(read.ok && read.value.fingerprint, "its new key's fingerprint, to compare");
  t.is(readFileSync(knownHosts, "utf8"), before, "the address still held to its old key");
  t.is(readFacts(platform, intentPath, ["home-ap-1"])["home-ap-1"]?.hostKey?.key, "AAAAoldkey");
  t.false(existsSync(`${intentPath}.state/inspected/10.0.0.143.known_hosts`), "the key it showed, recorded aside, is gone");
});

test("taking a reset device back pins exactly the key it showed, and only when that fingerprint is confirmed", async (t) => {
  const { platform, knownHosts, before, intentPath } = resetNetwork();
  const read = await inspectReset({ intentPath, platform, address: "10.0.0.143", name: "home-ap-1" });
  const fingerprint = read.ok ? read.value.fingerprint! : "";
  const refused = await readopt({ intentPath, platform, address: "10.0.0.143", name: "home-ap-1", fingerprint: "SHA256:another" });
  t.regex(!refused.ok ? refused.error.message : "", /not the key it showed/);
  t.is(readFileSync(knownHosts, "utf8"), before, "a different key at confirm time: nothing pinned");
  t.true((await readopt({ intentPath, platform, address: "10.0.0.143", name: "home-ap-1", fingerprint, now: () => 9 })).ok);
  t.is(readFileSync(knownHosts, "utf8"), `10.0.0.1 ssh-ed25519 AAAArouter\n10.0.0.143 ssh-ed25519 ${stockKey}\n`);
  t.is(readFacts(platform, intentPath, ["home-ap-1"])["home-ap-1"]?.hostKey?.key, stockKey, "its new key pinned, under its own name");
});

test("taking a reset device back: only one in Hardware, and its old key at its old address goes", async (t) => {
  const { platform, knownHosts, intentPath } = resetNetwork();
  // It came back at another address (an access point asks DHCP for one).
  writeFileSync(knownHosts, "10.0.0.120 ssh-ed25519 AAAAoldkey\n10.0.0.1 ssh-ed25519 AAAArouter\n");
  writeFacts(platform, intentPath, {
    hostname: "home-ap-1",
    readAt: 1,
    schema: { name: "zyxel,nwa50ax-pro", version: "25.12.5" },
    address: "10.0.0.120",
    macs: ["aa:00:00:00:00:43"],
    hostKey: { type: "ssh-ed25519", key: "AAAAoldkey" },
  });
  writeFacts(platform, intentPath, { hostname: "gone-ap", readAt: 1, schema: { name: "x", version: "25.12.5" }, macs: ["aa:00:00:00:00:43"] });
  const read = await inspectReset({ intentPath, platform, address: "10.0.0.143", name: "home-ap-1" });
  const fingerprint = read.ok ? read.value.fingerprint! : "";
  const notThere = await readopt({ intentPath, platform, address: "10.0.0.143", name: "gone-ap", fingerprint });
  t.regex(!notThere.ok ? notThere.error.message : "", /^gone-ap is not in Hardware/, "facts alone are not enough");
  t.true((await readopt({ intentPath, platform, address: "10.0.0.143", name: "home-ap-1", fingerprint, now: () => 9 })).ok);
  t.is(readFileSync(knownHosts, "utf8"), `10.0.0.1 ssh-ed25519 AAAArouter\n10.0.0.143 ssh-ed25519 ${stockKey}\n`, "nothing held at 10.0.0.120 for whatever answers there next");
});

test("Hardware › Add trusts nothing when it reads a device: the key is pinned when it is added, with its fingerprint confirmed", async (t) => {
  const { platform, knownHosts, intentPath } = resetNetwork();
  writeFileSync(knownHosts, "");
  const read = await inspectAt({ intentPath, platform, address: "10.0.0.150" });
  t.true(read.ok);
  t.is(readFileSync(knownHosts, "utf8"), "", "nothing trusted by reading it");
  const fingerprint = read.ok ? read.value.fingerprint! : "";
  t.false((await adopt({ intentPath, platform, address: "10.0.0.150", name: "ap-9", fingerprint: "SHA256:another" })).ok);
  t.is(readFileSync(knownHosts, "utf8"), "");
  // Another box than home-ap-1 (its MAC): the stand-in answers with home-ap-1's, so give it its own facts first.
  writeFacts(platform, intentPath, { hostname: "home-ap-1", readAt: 1, schema: { name: "x", version: "25.12.5" }, macs: ["aa:00:00:00:00:01"] });
  t.true((await adopt({ intentPath, platform, address: "10.0.0.150", name: "ap-9", fingerprint })).ok);
  t.is(readFileSync(knownHosts, "utf8"), `10.0.0.150 ssh-ed25519 ${stockKey}\n`);
});
