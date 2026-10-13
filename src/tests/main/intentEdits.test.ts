import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { keepSiteSeed, withNetworkAdded, withoutLine, withoutNetwork, withoutProvider } from "../../intent/edits";
import { compileIntent } from "../../intent/compile";
import { meshId } from "../../intent/features/mesh";
import { lineRole } from "../../intent/connections";
import { templateOf, templateSettings, withTemplate } from "../../intent/networkTemplates";
import { intentSchema } from "../../intent/schema";

const sample = () =>
  sampleIntent();

const withIot = () => {
  const intent = sample();
  const iot = templateSettings("iot", ["lan", "guest"]);
  intent.networks.push({
    id: "net2",
    name: "Gadgets",
    vlan: 30,
    subnet: "10.0.30.0/24",
    dhcp: { pool_size: 50, lease: "12h", reservations: [] },
    ipv6: false,
    share_devices: iot.share_devices,
    // A template says who it may reach, not which way out: the default, any line.
    access: { ...iot.access, fallback: true },
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
    ["wifi.networks.1.network"]
  );
});

test("removing a network removes the port forwards into it", (t) => {
  const intent = sample();
  intent.firewall.port_forwards[0].to.address = "10.0.20.9";
  t.deepEqual(withoutNetwork(intent, 1).firewall.port_forwards, []);
  t.is(withoutNetwork(sample(), 1).firewall.port_forwards.length, 1, "others stay");
});

const twoLines = () => {
  const intent = sample();
  const [main] = intent.internet.lines;
  intent.internet.lines = [
    main,
    { ...main, id: "wanb", name: "LTE", port: "lan4", failover: { ...main.failover, metered: true } },
    { ...main, id: "wanc", name: "Fibre", port: "lan3" },
  ];
  intent.networks[0].access = { ...intent.networks[0].access, via: "wanc", fallback: false };
  return intent;
};

test("removing a line or a provider puts its networks back on Automatic, with fallback", (t) => {
  const without = withoutLine(twoLines(), 2);
  t.deepEqual(without.internet.lines.map((l) => l.id), ["wan", "wanb"]);
  t.is(without.networks[0].access.via, undefined);
  t.true(without.networks[0].access.fallback);

  const intent = sample();
  intent.vpn.providers = [{ id: "tun1", name: "P", type: "openvpn", config: "client\n" }];
  intent.networks[0].access = { ...intent.networks[0].access, via: "tun1", fallback: false };
  const gone = withoutProvider(intent, 0);
  t.deepEqual(gone.vpn.providers, []);
  t.is(gone.networks[0].access.via, undefined);
  t.true(gone.networks[0].access.fallback);
});

test("a line's role follows failover's order: a metered line is last, backups numbered past it", (t) => {
  const intent = twoLines();
  t.deepEqual([0, 1, 2].map((i) => lineRole(intent, i).label), ["Main", "Last resort", "Backup"]);
  intent.internet.use_lines.mode = "balance";
  t.deepEqual([0, 1, 2].map((i) => lineRole(intent, i).label), ["Share 1", "Last resort", "Share 1"]);
});

test("renaming the site keeps its derived ids: the first name stays their seed", (t) => {
  const saved = sampleIntent();
  const renamed = { ...saved, system: { ...saved.system, name: "Elsewhere" } };
  const kept = keepSiteSeed(saved, renamed);
  t.is(kept.system.site_id, saved.system.name);
  t.is(keepSiteSeed(kept, { ...kept, system: { ...kept.system, name: "Again" } }).system.site_id, saved.system.name, "a second rename keeps the first");
  t.is(keepSiteSeed(saved, saved), saved, "no rename, nothing added");
  const ula = (intent: typeof saved) => JSON.stringify(compileIntent(intent)).match(/fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48/)?.[0];
  t.truthy(ula(saved));
  t.is(ula(kept), ula(saved), "the ULA prefix is as it was");
  t.is(meshId(kept), meshId(saved), "and the mesh id");
  t.not(ula(renamed), ula(saved), "where nothing kept it, the rename would have moved it");
});
