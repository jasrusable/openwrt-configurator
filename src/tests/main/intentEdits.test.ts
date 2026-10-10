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
    vlan: 30,
    subnet: "10.0.30.0/24",
    dhcp: { size: 50, lease: "12h" },
    ipv6: false,
  });
  return intent;
};

test("a new network gets its own zone, set up from its purpose", (t) => {
  const intent = withNetworkZone(withIot(), 2);
  t.like(intent.firewall.zones[3], {
    id: "net2",
    networks: ["net2"],
    input: "reject",
  });
  t.true(
    intent.firewall.rules.some((r) => r.name === "Allow-net2-DNS"),
    "a zone that rejects input still gets DHCP and DNS, as explicit rules"
  );
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
    ["lan", "wan"]
  );
  t.deepEqual(intent.firewall.forwardings, [{ from: "lan", to: "wan" }]);
  // As LuCI deletes a zone: the rules naming it go too.
  t.false(intent.firewall.rules.some((r) => r.from === "guest" || r.to === "guest"));
  // The Wi-Fi on it stays, flagged for the user.
  const result = intentSchema.safeParse(intent);
  t.deepEqual(
    result.success ? [] : result.error.issues.map((i) => i.path.join(".")),
    ["wifi.1.network"]
  );
});
