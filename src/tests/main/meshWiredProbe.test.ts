// The wired mesh's MTU and path check reads where the node runs it: the
// bridge's VLAN on DSA, the CPU's own VLAN device on swconfig.
import test from "ava";
import { spawnSync } from "child_process";
import { meshWired, meshWiredLink } from "../../status/device";

test("on DSA the bridge's VLAN over its ports; on swconfig the CPU's VLAN device over the CPU's", (t) => {
  t.deepEqual(meshWiredLink({ name: "dsa", version: "25.12.5", ports: [{ name: "lan1" }] }), {
    device: "br-lan.4000",
    carriers: "/sys/class/net/br-lan/brif/*",
    large: true,
  });
  const swconfig = { name: "c7", version: "25.12.5", sw_config: true, ports: [{ name: "port0", sw_config_cpu_name: "eth0" }, { name: "port1", switch_port: 1 }] };
  t.deepEqual(meshWiredLink(swconfig), { device: "eth0.4000", carriers: "/sys/class/net/eth0", large: false }, "a switch splits batman's frames");
  t.is(meshWiredLink({ ...swconfig, ports: [{ name: "port1", switch_port: 1 }] }), undefined, "no CPU port known: not read");
  t.is(meshWiredLink({ ...swconfig, ports: [{ name: "port0", sw_config_cpu_name: "eth0; reboot" }] }), undefined, "nothing a shell would read");
});

test("the probe reads that device, is sound shell, and parses its answer", (t) => {
  for (const link of [meshWiredLink({ name: "dsa", version: "25.12.5" })!, { device: "eth0.4000", carriers: "/sys/class/net/eth0" }]) {
    const { command, parse } = meshWired(link);
    t.true(command.includes(`/sys/class/net/${link.device};`) && command.includes(`-I ${link.device} `), link.device);
    t.is(spawnSync("sh", ["-n", "-c", command]).status, 0, `${link.device}: the shell reads it`);
    t.deepEqual(parse({ stdout: "1532 3 2\n", stderr: "", code: 0 }), { mtu: 1532, small: 3, large: 2 });
    t.is(parse({ stdout: "", stderr: "", code: 0 }), undefined, "no such device there: not read");
  }
});
