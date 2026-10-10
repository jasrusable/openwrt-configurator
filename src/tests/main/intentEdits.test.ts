import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { withNetworkInZone, withNetworkZone, withoutNetwork } from "../../intent/edits";
import { intentSchema } from "../../intent/schema";

const sample = () =>
  intentSchema.parse(
    JSON.parse(readFileSync(join(__dirname, "../../../sampleConfigs/intent.json"), "utf8"))
  );

const withIot = () => {
  const intent = sample();
  intent.networks.push({
    id: "net2",
    name: "Gadgets",
    purpose: "iot",
    isolate_clients: false,
    vlan: 30,
    subnet: "10.0.30.0/24",
    dhcp: { size: 50, lease: "12h" },
    ipv6: false,
  });
  return intent;
};

test("a new network gets its own zone, set up from its purpose", (t) => {
  const intent = withNetworkZone(withIot(), 2);
  t.like(intent.firewall.zones[2], {
    id: "net2",
    networks: ["net2"],
    input: "reject",
    router_services: true,
  });
  const to = (zone: string) =>
    intent.firewall.forwardings.filter((f) => f.to === zone).map((f) => f.from);
  const from = (zone: string) =>
    intent.firewall.forwardings.filter((f) => f.from === zone).map((f) => f.to);
  t.deepEqual(from("net2"), ["wan"], "IoT reaches only the internet");
  t.deepEqual(to("net2"), ["lan"], "Home, trusted, reaches it");
  t.true(intentSchema.safeParse(intent).success);
});

test("a network already put in a zone keeps it", (t) => {
  const intent = withNetworkInZone(withIot(), "net2", "guest");
  t.is(withNetworkZone(intent, 2), intent);
  t.deepEqual(intent.firewall.zones[1].networks, ["guest", "net2"]);
});

test("removing a network takes it out of its zone, and an emptied zone goes", (t) => {
  const intent = withoutNetwork(sample(), 1);
  t.deepEqual(
    intent.firewall.zones.map((z) => z.id),
    ["lan"]
  );
  t.deepEqual(intent.firewall.forwardings, [{ from: "lan", to: "wan" }]);
  // Its Wi-Fi and the rule naming its zone stay, flagged for the user.
  const result = intentSchema.safeParse(intent);
  t.false(result.success);
  t.deepEqual(
    result.success ? [] : result.error.issues.map((i) => i.path.join(".")),
    ["wifi.1.network", "firewall.rules.0.from"]
  );
});
