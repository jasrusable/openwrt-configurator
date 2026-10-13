import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { parseDeviceFacts } from "../../facts/board";
import { bestMode } from "../../engine/radioModes";

const boards = join(__dirname, "../helpers/boards");
const read_ = (file: string) => JSON.parse(readFileSync(join(boards, file), "utf8"));
const facts = (name: string, uciWireless?: unknown) =>
  deviceSchemaSchema.parse(
    parseDeviceFacts({ board: read_(`${name}.board.json`), system: read_(`${name}.system.json`), uciWireless })
  );

test("a DSA router: ports from network.lan's list and network.wan's device; model and release from ubus", (t) => {
  t.deepEqual(facts("nanopi-r6s"), {
    name: "friendlyarm,nanopi-r6s",
    model: "FriendlyElec NanoPi R6S",
    version: "25.12.5",
    sw_config: false,
    ports: [
      { name: "eth0", default_role: "lan" },
      { name: "eth2", default_role: "lan" },
      { name: "eth1", default_role: "wan" },
    ],
  });
});

test("an access point: one port as network.lan's device; radios from board.json's wlan, with their modes", (t) => {
  const ap = facts("nwa50ax-pro");
  t.deepEqual(ap.ports, [{ name: "eth0", default_role: "lan" }]);
  t.deepEqual(
    ap.radios?.map(({ band, path, max_width }) => [band, path, max_width]),
    [
      ["2g", "platform/soc/18000000.wifi", 40],
      ["5g", "platform/soc/18000000.wifi+1", 160],
    ]
  );
  t.true(ap.radios![1].htmodes!.includes("HE160"));
});

test("a single port under any name, as a container or a new board names it", (t) => {
  t.deepEqual(facts("docker-armsr").ports, [{ name: "eth0", default_role: "lan" }]);
  const end0 = parseDeviceFacts({
    board: { model: { id: "x,y" }, network: { lan: { device: "end0" } } },
    system: { board_name: "x,y", release: { version: "25.12.5" } },
  });
  t.deepEqual(end0.ports, [{ name: "end0", default_role: "lan" }], "no protocol needed either");
});

test("an older switch (swconfig), under any switch name; radios from UCI where board.json has no wlan", (t) => {
  const c50 = facts("swconfig-archer-c50", read_("swconfig-archer-c50.uci-wireless.json"));
  t.true(c50.sw_config);
  // In board.json's order, as OpenWrt's ucidef_add_switch writes it: the LAN ports first.
  t.deepEqual(c50.ports, [
    { name: "port1", switch_port: 1, default_role: "lan" },
    { name: "port2", switch_port: 2, default_role: "lan" },
    { name: "port3", switch_port: 3, default_role: "lan" },
    { name: "port4", switch_port: 4, default_role: "lan" },
    { name: "port0", switch_port: 0, default_role: "wan" },
    { name: "port6", switch_port: 6, sw_config_cpu_name: "eth0" },
  ]);
  t.deepEqual(
    c50.radios?.map((r) => [r.name, r.band, r.path]),
    [
      ["radio0", "2g", "platform/10300000.wmac"],
      ["radio1", "5g", "pci0000:00/0000:00:00.0/0000:01:00.0"],
    ]
  );
  const renamed = read_("swconfig-archer-c50.board.json");
  renamed.switch = { rtl8367: renamed.switch.switch0 };
  t.is(parseDeviceFacts({ board: renamed, system: read_("swconfig-archer-c50.system.json") }).ports?.length, 6);
});

test("a switch board with the WAN on a NIC of its own: that NIC a port beside the switch's", (t) => {
  // The Archer C60 v2, as OpenWrt 25.12's board.d makes it: the CPU on eth0, the WAN on eth1.
  const c60 = facts("swconfig-wan-nic");
  t.true(c60.sw_config);
  t.deepEqual(c60.ports, [
    { name: "port0", switch_port: 0, sw_config_cpu_name: "eth0" },
    { name: "port1", switch_port: 1, default_role: "lan" },
    { name: "port2", switch_port: 2, default_role: "lan" },
    { name: "port3", switch_port: 3, default_role: "lan" },
    { name: "port4", switch_port: 4, default_role: "lan" },
    { name: "eth1", default_role: "wan" },
  ]);
});

test("one wiphy with several radios: one each, told apart by radio; a phy with its own name by phy", (t) => {
  const r4 = facts("wifi7-multiradio");
  t.deepEqual(
    r4.radios?.map(({ band, radio, path, phy }) => ({ band, radio, byPath: !!path, phy })),
    [
      { band: "2g", radio: 0, byPath: true, phy: undefined },
      { band: "5g", radio: 1, byPath: true, phy: undefined },
      { band: "6g", radio: 2, byPath: true, phy: undefined },
      { band: "5g", radio: undefined, byPath: false, phy: "wiphy-odd" },
    ]
  );
});

test("what cannot be used is skipped and said; only no ports at all fails", (t) => {
  const odd = parseDeviceFacts({
    board: {
      network: { lan: { ports: ["lan1"] } },
      wlan: { phy0: { path: "p", info: { bands: { "45G": { modes: [] } } } } },
    },
    system: { board_name: "x,y", release: { version: "25.12.5" } },
  });
  t.deepEqual(odd.skipped, ["phy0: no band this app supports"]);
  t.is(odd.radios, undefined);
  t.throws(
    () => parseDeviceFacts({ board: { network: {} }, system: { board_name: "x,y", release: { version: "25.12.5" } } }),
    { message: /lists no ports/ }
  );
  t.throws(() => parseDeviceFacts({ board: {}, system: {} }), { message: /names no board/ });
});

test("a radio's mode: the newest standard it has, at the widest width up to the one asked", (t) => {
  const [, ac] = facts("wifi7-multiradio").radios!.filter((r) => r.band === "5g");
  const [twoG, fiveG] = facts("nwa50ax-pro").radios!;
  const [, , sixG] = facts("wifi7-multiradio").radios!;
  t.is(bestMode(80, fiveG.htmodes), "HE80", "Wi-Fi 6 at 80 MHz");
  t.is(bestMode(80, twoG.htmodes), "HE40", "capped at what the radio has");
  t.is(bestMode(80, ac.htmodes), "VHT80", "a Wi-Fi 5 radio gets VHT, not HE");
  t.is(bestMode(320, sixG.htmodes), "EHT320", "Wi-Fi 7");
  t.is(bestMode(80, undefined), "HE80", "modes unknown: as before");
  t.is(bestMode(20, []), undefined, "nothing fits: OpenWrt's default");
});

test("whether each radio can be a mesh point: as read on the access point; unknown where not read", (t) => {
  // Recorded from the Zyxel NWA50AX Pro on 25.12.5 with the meshSupport probe.
  const read = { phy0: true, phy1: true };
  const ap = deviceSchemaSchema.parse(
    parseDeviceFacts({ board: read_("nwa50ax-pro.board.json"), system: read_("nwa50ax-pro.system.json"), meshSupport: read })
  );
  t.deepEqual(ap.radios?.map((r) => r.mesh), [true, true]);
  t.deepEqual(facts("nwa50ax-pro").radios?.map((r) => r.mesh), [undefined, undefined]);
});

test("a switch's own name is kept; a second switch is said, not guessed at", (t) => {
  const board = read_("swconfig-archer-c50.board.json");
  const system = read_("swconfig-archer-c50.system.json");
  t.is(parseDeviceFacts({ board, system }).switch, "switch0");
  const renamed = { ...board, switch: { rtl8367: board.switch.switch0 } };
  t.is(parseDeviceFacts({ board: renamed, system }).switch, "rtl8367");
  const two = { ...board, switch: { switch0: board.switch.switch0, switch1: board.switch.switch0 } };
  const facts = parseDeviceFacts({ board: two, system });
  t.is(facts.switch, "switch0");
  t.true(facts.skipped!.some((s) => /switch1: a second switch/.test(s)));
  t.is(parseDeviceFacts({ board: read_("nanopi-r6s.board.json"), system: read_("nanopi-r6s.system.json") }).switch, undefined, "DSA: no switch");
});


test("each radio's channels, from nl80211: its band's enabled frequencies, within its own ranges on a shared wiphy", (t) => {
  const ap = parseDeviceFacts({
    board: read_("nwa50ax-pro.board.json"),
    system: read_("nwa50ax-pro.system.json"),
    // phy0's both bands in one list, as nl80211 gives a dual-band wiphy (2.4: 1, 6, 11; 5: 36, 149).
    wiphys: { phy0: { freqs: [2412, 2437, 2462], radios: [] }, phy1: { freqs: [5180, 5745], radios: [] } },
  });
  t.deepEqual(ap.radios?.map((r) => [r.band, r.channels]), [["2g", [1, 6, 11]], ["5g", [36, 149]]]);

  const shared = parseDeviceFacts({
    board: read_("wifi7-multiradio.board.json"),
    system: read_("wifi7-multiradio.system.json"),
    wiphys: {
      phy0: {
        freqs: [2412, 5180, 5745, 6135],
        radios: [
          { index: 0, ranges: [[2400000, 2500000]] },
          { index: 1, ranges: [[5150000, 5250000]] },
          { index: 2, ranges: [[5925000, 7125000]] },
        ],
      },
    },
  });
  t.deepEqual(
    shared.radios?.filter((r) => r.name === "phy0").map((r) => [r.radio, r.channels]),
    [[0, [1]], [1, [36]], [2, [37]]],
    "5745 (149) is in no radio's range here"
  );
  t.is(parseDeviceFacts({ board: read_("nwa50ax-pro.board.json"), system: read_("nwa50ax-pro.system.json") }).radios![0].channels, undefined, "unknown when not read");
});
