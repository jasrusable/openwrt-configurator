import test from "ava";
import { diffIntent } from "../../intent/diff";

const base = {
  system: { name: "Home", timezone: "Europe/Zurich", country: "CH" },
  internet: {
    lines: [{ id: "wan", name: "Fibre", type: "dhcp", ipv6: { enabled: true }, shaping: { down_mbps: 950, up_mbps: 950 } }],
  },
  wifi: { networks: [{ ssid: "Home", password: "hunter2-hunter2" }] },
  dns: { upstream: { type: "encrypted", provider: "cloudflare" } },
};
const edit = (change: (intent: any) => void) => {
  const intent = JSON.parse(JSON.stringify(base));
  change(intent);
  return intent;
};

test("no changes, no diff", (t) => {
  t.deepEqual(diffIntent(base, edit(() => {})), []);
});

test("a setting changes from one value to another, labelled for people", (t) => {
  const [change] = diffIntent(base, edit((i) => (i.internet.lines[0].shaping.down_mbps = 900)));
  t.deepEqual(change.label, ["Internet", "Connections", "“Fibre”", "Smart queueing", "Download"]);
  t.is(change.kind, "changed");
  t.is(change.before, "950 Mbit/s");
  t.is(change.after, "900 Mbit/s");
});

test("list items are named by their value, and secrets never shown", (t) => {
  const changes = diffIntent(base, edit((i) => (i.wifi.networks[0].password = "new-password-1")));
  t.deepEqual(changes[0].label, ["Wi-Fi", "“Home”", "Password"]);
  t.is(changes[0].before, undefined);
  t.is(changes[0].after, undefined);
  t.true(changes[0].description!.includes("join again"));
  t.false(JSON.stringify(changes).includes("hunter2"));
  t.false(JSON.stringify(changes).includes("new-password-1"));
});

test("whole items and optional groups are added and removed as one change", (t) => {
  const added = diffIntent(
    base,
    edit((i) => i.wifi.networks.push({ ssid: "Guest", password: "guest-pass-1" }))
  );
  t.deepEqual(
    added.map((c) => [c.label.join(" › "), c.kind]),
    [["Wi-Fi › “Guest”", "added"]]
  );
  t.false(JSON.stringify(added).includes("guest-pass-1"));
  const removed = diffIntent(base, edit((i) => delete i.internet.lines[0].shaping));
  t.deepEqual(
    removed.map((c) => [c.label.join(" › "), c.kind]),
    [["Internet › Connections › “Fibre” › Smart queueing", "removed"]]
  );
});

test("switching the kind of connection is one change", (t) => {
  const changes = diffIntent(
    base,
    edit((i) => Object.assign(i.internet.lines[0], { type: "pppoe", pppoe: { username: "u", password: "p" } }))
  );
  t.deepEqual(
    changes.map((c) => [c.label.join(" › "), c.before, c.after]),
    [["Internet › Connections › “Fibre” › Connection", "dhcp", "pppoe"]]
  );
});

test("a list item removed from the middle is one removal, not every later item changed; a rename stays a rename", (t) => {
  const ssid = (name: string) => ({ ssid: name, password: "x" });
  const wifi = (networks: unknown[]) => ({ wifi: { networks } });
  const removed = diffIntent(wifi([ssid("Home"), ssid("Guests"), ssid("IoT")]), wifi([ssid("Guests"), ssid("IoT")]));
  t.deepEqual(removed.map((c) => [c.kind, c.path]), [["removed", "wifi.networks.0"]]);
  const renamed = diffIntent(wifi([ssid("Home"), ssid("IoT")]), wifi([ssid("House"), ssid("IoT")]));
  t.deepEqual(renamed.map((c) => [c.kind, c.path, c.before, c.after]), [["changed", "wifi.networks.0.ssid", "Home", "House"]]);
});
