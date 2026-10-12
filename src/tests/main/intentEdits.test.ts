import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { withNetworkAdded, withoutNetwork } from "../../intent/edits";
import { templateOf, templateSettings, withTemplate } from "../../intent/networkTemplates";
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
    vlan: 30,
    subnet: "10.0.30.0/24",
    dhcp: { size: 50, lease: "12h" },
    ipv6: false,
    reservations: [],
    ...templateSettings("iot", ["lan", "guest"]),
  });
  return intent;
};

test("templates: home reaches all and shares; guests only go out; IoT is found from home", (t) => {
  t.deepEqual(templateSettings("home", ["guest"]), {
    access: { internet: true, networks: ["guest"], router: "full" },
    share_devices: true,
  });
  t.deepEqual(templateSettings("guest", ["lan"]), {
    access: { internet: true, networks: [], router: "services" },
    share_devices: false,
  });
  t.true(templateSettings("iot", []).share_devices);
});

test("which template a network follows is read off its settings, and Custom otherwise", (t) => {
  const intent = withIot();
  t.is(templateOf(intent.networks, 2), "iot");
  const tuned = { ...intent.networks[2], access: { ...intent.networks[2].access, internet: false } };
  t.is(templateOf([...intent.networks.slice(0, 2), tuned], 2), "custom", "changed by hand");
  const asGuest = withTemplate(intent, 2, "guest");
  t.is(templateOf(asGuest.networks, 2), "guest");
  t.false(asGuest.networks[2].share_devices);
  t.true(intentSchema.safeParse(asGuest).success);
});

test("a new network is reachable from trusted networks (full router access), and from no others", (t) => {
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
