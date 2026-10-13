// Many valid intents (src/tests/helpers/intentGenerator.ts: the sample after
// random sequences of the edits the app allows), each compiled and fitted to
// every captured board, and checked against what must hold of any of them
// (generativeCheck.ts). Features interact (metered lines with IPv6, the mesh
// with a reserved band, a tunnel with port forwards); examples alone do not
// explore that.
//
// ONC_GEN_CASES=2000 npx ava src/tests/main/generative.test.ts  — more cases.
import test from "ava";
import { check, configProblems } from "../helpers/generativeCheck";

const cases = Number(process.env.ONC_GEN_CASES ?? 200);
const seedOf = (i: number) => 1_000_003 + i;

test(`${cases} generated intents compile, fit every captured board, and verify`, (t) => {
  const failures = Array.from({ length: cases }, (_, i) => seedOf(i)).flatMap((seed) =>
    check(seed).map((problem) => `seed ${seed}: ${problem}`)
  );
  // generateIntent(seed) makes the failing intent again.
  t.deepEqual(failures.slice(0, 20), [], `${failures.length} problems`);
});

test("the checks catch what they are for: a name twice, a dangling reference, a port untagged twice", (t) => {
  const section = (type: string, name: string | undefined, options: Record<string, string | string[]>) => ({ type, name, options });
  t.deepEqual(
    configProblems({
      network: [
        section("interface", "lan", {}),
        section("interface", "lan", {}),
        section("bridge-vlan", undefined, { device: "br-lan", vlan: "1", ports: ["lan1", "lan2:t"] }),
        section("bridge-vlan", undefined, { device: "br-lan", vlan: "20", ports: ["lan1", "lan2:t"] }),
        section("switch_vlan", undefined, { device: "switch0", vlan: "1", ports: "0t 1 2" }),
        section("switch_vlan", undefined, { device: "switch0", vlan: "2", ports: "0t 2" }),
      ],
      wireless: [section("wifi-iface", "home", { network: "iot" })],
      dhcp: [section("dhcp", "guest", { interface: "guest" })],
      firewall: [section("zone", "lan", { network: ["lan", "gone"] })],
    }),
    [
      "two sections named network.lan",
      "wireless.home network names iot, no interface",
      "dhcp.guest interface names guest, no interface",
      "firewall.lan network names gone, no interface",
      "br-lan/lan1 untagged in VLANs 1, 20",
      "switch0/2 untagged in VLANs 1, 2",
    ]
  );
});
