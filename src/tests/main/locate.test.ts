import test from "ava";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceFacts } from "../../deviceFacts";
import { candidatesFor, Located, locateEach, NotLocated, parseNeighbours } from "../../locate";
import { checkHostKey, formatKnownHost, parseKnownHosts } from "../../knownHosts";
import { Platform, Session, SshTarget } from "../../platform";
import { nodePlatform } from "../../platforms/node";
import { ProvisionableDevice } from "../../provisionConfig";

/** A machine on the fake network: its board, MACs, host key, and (a router) its tables. */
type Machine = { board: string; macs: string[]; key: string; leases?: string; neighbours?: string };

const board = (id: string) =>
  JSON.stringify({ model: { id, name: id }, network: { lan: { ports: ["lan1"], protocol: "static" } } });

/** Answers the probes the way a device does: each output, then its exit marker. */
const session = (m: Machine): Session => ({
  execCommand: async (command: string) => {
    const parts = command.split(/\n\) 2>\/dev\/null; printf '\\n__ONC_PROBE__%s\\n' "\$\?"\n?/).filter((p) => p.trim());
    const answer = (part: string) =>
      part.includes("board.json")
        ? m.board
        : part.includes("ubus call uci get")
        ? '{"values":{}}'
        : part.includes("openwrt_release")
        ? "DISTRIB_RELEASE='25.12.5'"
        : part.includes("/sys/class/net")
        ? m.macs.join("\n")
        : part.includes("dhcp.leases")
        ? m.leases ?? ""
        : part.includes("neigh")
        ? m.neighbours ?? ""
        : "";
    return { stdout: parts.map((p) => `${answer(p)}\n__ONC_PROBE__0\n`).join(""), stderr: "", code: 0 };
  },
  dispose: () => {},
});

/** A network of machines by address; connect checks host keys as the real platforms do. */
const network = (machines: Record<string, Machine>) => {
  const knownHosts = join(mkdtempSync(join(tmpdir(), "onc-locate-")), "known_hosts");
  writeFileSync(knownHosts, "");
  const tried: string[] = [];
  const platform: Platform = {
    ...nodePlatform,
    env: (name) => (name === "ONC_KNOWN_HOSTS" ? knownHosts : undefined),
    connect: async (target: SshTarget) => {
      const host = target.host ?? "";
      tried.push(host);
      const m = machines[host];
      if (!m) throw new Error("connect ECONNREFUSED");
      const offered = { host, type: "ssh-ed25519", key: m.key };
      // A pinned key is checked by the client itself; the file is not involved.
      if (target.hostKey) {
        if (target.hostKey.key !== m.key || target.hostKey.type !== offered.type) throw new Error("host key changed");
        return session(m);
      }
      const seen = checkHostKey(parseKnownHosts(readFileSync(knownHosts, "utf8")), offered);
      if (seen === "changed") throw new Error("host key changed");
      if (seen === "new") writeFileSync(knownHosts, readFileSync(knownHosts, "utf8") + formatKnownHost(offered));
      return session(m);
    },
  };
  return { platform, tried, knownHosts };
};

const device = (hostname: string, ipaddr: string, role: string): ProvisionableDevice =>
  ({ hostname, ipaddr, tags: { role }, provisioning_config: { ssh_auth: { username: "root" } } }) as ProvisionableDevice;

const router = device("home-router", "10.0.0.1", "router");
const ap = device("home-ap-1", "home-ap-1.lan", "access-point");
const apFacts: DeviceFacts = {
  hostname: "home-ap-1",
  readAt: 1,
  schema: { name: "zyxel,nwa50ax-pro", version: "25.12.5", ports: [{ name: "lan1", default_role: "lan" }] },
  address: "10.0.0.50",
  macs: ["aa:bb:cc:00:00:01"],
  hostKey: { type: "ssh-ed25519", key: "AP-KEY" },
};
const routerMachine = (leases: string): Machine => ({
  board: board("friendlyarm,nanopi-r6s"),
  macs: ["aa:bb:cc:00:00:99"],
  key: "ROUTER-KEY",
  leases,
  neighbours: "",
});
const apMachine: Machine = { board: board("zyxel,nwa50ax-pro"), macs: ["aa:bb:cc:00:00:01"], key: "AP-KEY" };

const settle = async (promises: Promise<Located | NotLocated>[]) => {
  const all = await Promise.all(promises);
  all.forEach((r) => "session" in r && r.session.dispose());
  return all;
};

test("where to look: last reached, the settings, the router's leases by name, then by MAC", (t) => {
  const leases = [
    { mac: "aa:bb:cc:00:00:01", address: "10.0.0.77", expires: 1 },
    { mac: "ff:ff:ff:00:00:00", address: "10.0.0.88", name: "home-ap-1", expires: 1 },
  ];
  t.deepEqual(
    candidatesFor({ deviceConfig: ap, facts: apFacts, leases, neighbours: parseNeighbours("10.0.0.50 dev br-lan lladdr aa:bb:cc:00:00:01 STALE") }).map((c) => c.address),
    ["10.0.0.50", "home-ap-1.lan", "10.0.0.88", "10.0.0.77"]
  );
});

test("a device that moved is found by its MAC in the router's leases, and pinned to its own key", async (t) => {
  const net = network({
    "10.0.0.1": routerMachine("1 aa:bb:cc:00:00:01 10.0.0.77 * *"),
    "10.0.0.77": apMachine,
  });
  const [r, a] = await settle(locateEach({ devices: [router, ap], facts: { "home-ap-1": apFacts }, platform: net.platform }));
  t.true("session" in r);
  t.like(a, { hostname: "home-ap-1", address: "10.0.0.77", macs: ["aa:bb:cc:00:00:01"] });
  t.deepEqual(net.tried, ["10.0.0.1", "10.0.0.50", "home-ap-1.lan", "10.0.0.77"]);
  t.false(readFileSync(net.knownHosts, "utf8").includes("AP-KEY"), "pinned in the connection, not the shared file");
});

test("another machine using its name is refused by its host key", async (t) => {
  const net = network({
    "10.0.0.1": routerMachine("1 ff:ff:ff:00:00:00 10.0.0.66 home-ap-1 *"),
    "10.0.0.66": { board: board("zyxel,nwa50ax-pro"), macs: ["ff:ff:ff:00:00:00"], key: "IMPOSTOR-KEY" },
  });
  const [, a] = await settle(locateEach({ devices: [router, ap], facts: { "home-ap-1": apFacts }, platform: net.platform }));
  t.false("session" in a);
  t.regex((a as NotLocated).error, /10\.0\.0\.66 \(its name in the router's leases\): host key changed/);
});

test("a different board where the device used to be is refused", async (t) => {
  const net = network({ "10.0.0.1": routerMachine(""), "10.0.0.50": { ...apMachine, board: board("tplink,archer-c50-v4") } });
  const [, a] = await settle(locateEach({ devices: [router, ap], facts: { "home-ap-1": apFacts }, platform: net.platform }));
  t.regex((a as NotLocated).error, /10\.0\.0\.50 \(where it was last reached\): 10\.0\.0\.50 is a tplink,archer-c50-v4, not home-ap-1/);
});

test("first contact: trusted at its configured address, and its key remembered", async (t) => {
  const net = network({ "10.0.0.1": routerMachine(""), "home-ap-1.lan": apMachine });
  const [, a] = await settle(locateEach({ devices: [router, ap], facts: {}, platform: net.platform }));
  t.like(a, { address: "home-ap-1.lan", hostKey: { type: "ssh-ed25519", key: "AP-KEY" } });
});

test("fail closed: an address the app found is never tried without a host key to pin it to", async (t) => {
  // An impostor claims the access point's name in DHCP; the real one is not yet known by key.
  const net = network({
    "10.0.0.1": routerMachine("1 ff:ff:ff:00:00:00 10.0.0.66 home-ap-1 *\n1 aa:bb:cc:00:00:01 10.0.0.77 * *"),
    "10.0.0.66": { board: board("zyxel,nwa50ax-pro"), macs: ["ff:ff:ff:00:00:00"], key: "IMPOSTOR-KEY" },
  });
  const { hostKey: _none, ...withoutKey } = apFacts;
  for (const facts of [{}, { "home-ap-1": withoutKey }]) {
    net.tried.length = 0;
    const [, a] = await settle(locateEach({ devices: [router, ap], facts, platform: net.platform }));
    t.false("session" in a);
    t.false(net.tried.includes("10.0.0.66"), "no credentials sent to a name anyone can claim");
    t.false(net.tried.includes("10.0.0.77") || net.tried.includes("10.0.0.50"));
    t.regex((a as NotLocated).error, /not tried, no host key on record/);
  }
});

test("a known device is held to its key by the SSH client, and the shared known_hosts is never touched", async (t) => {
  const net = network({ "10.0.0.1": routerMachine(""), "10.0.0.50": apMachine });
  const unreadable = join(mkdtempSync(join(tmpdir(), "onc-locate-")), "known_hosts");
  mkdirSync(unreadable); // reading it would fail: a pinned attempt must not need it
  const pins: unknown[] = [];
  const platform = {
    ...net.platform,
    env: (name: string) => (name === "ONC_KNOWN_HOSTS" ? unreadable : undefined),
    connect: (target: SshTarget) => {
      pins.push(target.hostKey);
      return net.platform.connect(target);
    },
  };
  const [a] = await settle(locateEach({ devices: [ap], facts: { "home-ap-1": apFacts }, platform }));
  t.like(a, { address: "10.0.0.50", hostKey: apFacts.hostKey });
  t.deepEqual(pins, [apFacts.hostKey]);
  t.true(statSync(unreadable).isDirectory(), "left as it was");
});
