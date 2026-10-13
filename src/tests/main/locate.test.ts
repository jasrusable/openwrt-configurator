import test from "ava";
import { readFileSync, writeFileSync } from "fs";
import { DeviceFacts } from "../../deviceFacts";
import { candidatesFor, isAddress, Located, locateEach, NotLocated, parseNeighbours } from "../../locate";
import { formatKnownHost } from "../../knownHosts";
import { ProvisionableDevice } from "../../provisionConfig";
import { board, Machine, network } from "../helpers/fakeNetwork";

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
  const routerOnly = network({ "10.0.0.1": routerMachine("") });
  const [r] = await settle(locateEach({ devices: [router], facts: {}, platform: routerOnly.platform }));
  t.like(r, { address: "10.0.0.1", hostKey: { type: "ssh-ed25519", key: "ROUTER-KEY" } });
});

test("a name in the settings is what DHCP says: never trusted on first use", async (t) => {
  const net = network({ "10.0.0.1": routerMachine(""), "home-ap-1.lan": { ...apMachine, key: "IMPOSTOR-KEY" } });
  const [, a] = await settle(locateEach({ devices: [router, ap], facts: {}, platform: net.platform }));
  t.regex((a as NotLocated).error, /home-ap-1\.lan \(where your settings put it\): not tried, no host key on record.*Hardware › Add/);
  t.false(net.tried.includes("home-ap-1.lan"));
});

test("a name SSH already trusts is held to that key", async (t) => {
  const net = network({ "10.0.0.1": routerMachine(""), "home-ap-1.lan": apMachine });
  writeFileSync(net.knownHosts, formatKnownHost({ host: "home-ap-1.lan", type: "ssh-ed25519", key: "AP-KEY" }));
  const [, a] = await settle(locateEach({ devices: [router, ap], facts: {}, platform: net.platform }));
  t.like(a, { address: "home-ap-1.lan", hostKey: { type: "ssh-ed25519", key: "AP-KEY" } });
});

test("found by name, used by the address it answered on: a name can go when the router's leases do", async (t) => {
  const net = network({ "10.0.0.1": routerMachine(""), "home-ap-1.lan": { ...apMachine, ip: "10.0.0.50" } });
  writeFileSync(net.knownHosts, formatKnownHost({ host: "home-ap-1.lan", type: "ssh-ed25519", key: "AP-KEY" }));
  const [, a] = await settle(locateEach({ devices: [router, ap], facts: {}, platform: net.platform }));
  t.like(a, { address: "10.0.0.50", hostKey: { type: "ssh-ed25519", key: "AP-KEY" } });
});

test("only a real address counts as one: nothing an ssh argument could be", (t) => {
  t.true(isAddress("10.0.0.50"));
  t.true(isAddress("fe80::1"));
  t.false(isAddress("999.1.1.1"));
  t.false(isAddress("-oProxyCommand=touch:x"));
  t.false(isAddress("home-ap-1.lan"));
  t.false(isAddress("a:b"), "one colon is no IPv6 address");
});

test("a device's word for its address is not taken for an address we gave it", async (t) => {
  const net = network({ "10.0.0.1": { ...routerMachine(""), ip: "10.0.0.99" } });
  const [r] = await settle(locateEach({ devices: [router], facts: {}, platform: net.platform }));
  t.like(r, { address: "10.0.0.1" });
});

test("each device is found in one round trip, the router's tables included", async (t) => {
  const net = network({
    "10.0.0.1": routerMachine("1 aa:bb:cc:00:00:01 10.0.0.77 * *"),
    "10.0.0.77": apMachine,
  });
  let execs = 0;
  const platform = {
    ...net.platform,
    connect: async (target: Parameters<typeof net.platform.connect>[0]) => {
      const s = await net.platform.connect(target);
      return { ...s, execCommand: (c: string) => (execs++, s.execCommand(c)) };
    },
  };
  const [r, a] = await settle(locateEach({ devices: [router, ap], facts: { "home-ap-1": apFacts }, platform }));
  t.true("session" in r && "session" in a);
  t.deepEqual((r as Located).tables?.leases.map((l) => l.address), ["10.0.0.77"]);
  t.is(execs, 2);
});
