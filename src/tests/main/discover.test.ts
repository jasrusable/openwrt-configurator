import test from "ava";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceFacts } from "../../deviceFacts";
import { discoverCandidates, inspect, suggestName, suggestRole } from "../../discover";
import { Intent, intentSchema } from "../../intent/schema";
import { Platform, Session, SshTarget } from "../../platform";
import { nodePlatform } from "../../platforms/node";
import { parseLeases } from "../../status/device";

const root = join(__dirname, "..", "..", "..");
const sample = (): Intent =>
  intentSchema.parse(JSON.parse(readFileSync(join(root, "sampleConfigs", "intent.json"), "utf8")));

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
  const knownHosts = join(mkdtempSync(join(tmpdir(), "onc-discover-")), "known_hosts");
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
      writeFileSync(knownHosts, `${target.host} ssh-ed25519 STOCK-KEY\n`);
      return session;
    },
  };
  return { platform, targets };
};

test("a stock device is read with OpenWrt's default, never the admin password, and flagged as open", async (t) => {
  const intent = sample();
  intent.system = { ...intent.system, app_login: { key: "/tmp/id_test", password: "the-admin-secret" } };
  const { platform, targets } = stock({ key: false });
  const read = await inspect({ address: "10.0.0.143", intent, platform });
  t.like(read, {
    address: "10.0.0.143",
    hostname: "OpenWrt",
    macs: ["aa:00:00:00:00:43"],
    hostKey: { type: "ssh-ed25519", key: "STOCK-KEY" },
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
  t.false(read.openLogin);
});
