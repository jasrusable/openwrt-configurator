// For scripts/mwan3-test.sh: what the app compiles for a router with two
// lines (wan on eth1 with IPv6, wanb on eth2, failover), offline, from the
// sample intent: the mwan3 config, the lines' interfaces, and the
// IPv6-follows-the-line hook. Printed as a shell script the test runs on the
// router container: uci commands, then the hook written in place.
import { readFileSync } from "fs";
import { join } from "path";
import { getOpenWrtState } from "../src/engine/getOpenWrtState";
import { getUciCommands } from "../src/engine/getUciCommands";
import { compileIntent } from "../src/intent/compile";
import { intentSchema } from "../src/intent/schema";
import { shellQuote } from "../src/shell";

const root = join(__dirname, "..");
const sample = JSON.parse(readFileSync(join(root, "sampleConfigs/intent.json"), "utf8"));
const [main] = sample.internet.lines;
const intent = intentSchema.parse({
  ...sample,
  internet: {
    ...sample.internet,
    lines: [
      { ...main, id: "wan", name: "Fibre", type: "dhcp", port: "eth1", ipv6: { enabled: true } },
      { id: "wanb", name: "Backup", type: "dhcp", port: "eth2" },
    ],
    use_lines: { mode: "failover" },
  },
});
const plan = compileIntent(intent);
const router = plan.devices.find((d) => d.tags?.role === "router")!;
// The container as the engine sees it: three plain ports, eth0 the LAN.
const state = getOpenWrtState({
  plan,
  deviceConfig: router,
  deviceSchema: {
    name: "orbstack,virt",
    version: "25.12.5",
    ports: [{ name: "eth0", default_role: "lan" }, { name: "eth1" }, { name: "eth2" }],
  },
});
const lines = new Set(["wan", "wan6", "wanb"]);
const config = {
  mwan3: state.config.mwan3 ?? {},
  network: { interface: (state.config.network?.interface ?? []).filter((s) => lines.has(s[".name"])) },
};
const hook = (state.files ?? []).find((f) => f.path.endsWith("17-onc-ipv6-follows-line"));
if (!hook) throw new Error("The compiler emitted no IPv6-follows-the-line hook for two lines with IPv6 on the main one.");
console.log(
  [
    "set -e",
    ...getUciCommands({ openWrtConfig: config as never }),
    "uci commit mwan3; uci commit network",
    `printf '%s' ${shellQuote(hook.content)} > ${hook.path}`,
  ].join("\n")
);
