import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { parseDeviceFacts } from "../../facts/board";
import { resolveHtmode } from "../../radioModes";

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
  t.deepEqual(c50.ports, [
    { name: "eth0", default_role: "wan" },
    { name: "eth1", default_role: "lan" },
    { name: "eth2", default_role: "lan" },
    { name: "eth3", default_role: "lan" },
    { name: "eth4", default_role: "lan" },
    { name: "eth6", sw_config_cpu_name: "eth0" },
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
  t.is(resolveHtmode("@best/80", fiveG.htmodes), "HE80", "Wi-Fi 6 at 80 MHz");
  t.is(resolveHtmode("@best/80", twoG.htmodes), "HE40", "capped at what the radio has");
  t.is(resolveHtmode("@best/80", ac.htmodes), "VHT80", "a Wi-Fi 5 radio gets VHT, not HE");
  t.is(resolveHtmode("@best/320", sixG.htmodes), "EHT320", "Wi-Fi 7");
  t.is(resolveHtmode("@best/80", undefined), "HE80", "modes unknown: as before");
  t.is(resolveHtmode("@best/20", []), undefined, "nothing fits: OpenWrt's default");
  t.is(resolveHtmode("VHT40", ac.htmodes), "VHT40", "a mode given outright is kept");
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
