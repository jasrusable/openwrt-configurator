import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { accessForPurpose } from "../../intent/firewall";
import { withNetworkAdded, withoutNetwork } from "../../intent/edits";
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
    access: accessForPurpose("iot", ["lan", "guest"]),
    reservations: [],
    share_devices: false,
  });
  return intent;
};

test("a purpose sets a new network's access: home reaches all, others only out", (t) => {
  t.deepEqual(accessForPurpose("home", ["guest"]), { internet: true, networks: ["guest"], router: "full" });
  t.deepEqual(accessForPurpose("guest", ["lan"]), { internet: true, networks: [], router: "services" });
});

test("a new network is reachable from home networks, and from no others", (t) => {
  const intent = withNetworkAdded(withIot(), 2);
  t.deepEqual(intent.networks[0].access.networks, ["guest", "net2"], "home reaches it");
  t.deepEqual(intent.networks[1].access.networks, [], "guests do not");
  t.deepEqual(intent.networks[2].access.networks, [], "it reaches no one");
  t.true(intentSchema.safeParse(intent).success);
});

test("removing a network removes every reference to it", (t) => {
  const intent = withoutNetwork(sample(), 1);
  t.deepEqual(intent.networks[0].access.networks, []);
  t.false(intent.firewall.rules.some((r) => r.from === "guest" || r.to === "guest"));
  // The Wi-Fi on it stays, flagged for the user.
  const result = intentSchema.safeParse(intent);
  t.deepEqual(
    result.success ? [] : result.error.issues.map((i) => i.path.join(".")),
    ["wifi.1.network"]
  );
});

test("removing a network removes the port forwards into it", (t) => {
  const intent = sample();
  intent.firewall.port_forwards[0].internal_address = "10.0.20.9";
  t.deepEqual(withoutNetwork(intent, 1).firewall.port_forwards, []);
  t.is(withoutNetwork(sample(), 1).firewall.port_forwards.length, 1, "others stay");
});
