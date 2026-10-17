// ⌘K: every setting found by its label, what it does or what OpenWrt calls
// it, once per item it is for and only where the settings hold its part; a
// link to its row; never its value.
import test from "ava";
import { find, settingEntries } from "../../../ui/src/findable";
import { sampleIntent } from "../helpers/fixtures";

const intent = sampleIntent();
const entries = settingEntries(intent);

test("a setting of a list item is listed for each item, named by it, linking to its row", (t) => {
  const passwords = find(entries, "password").filter((e) => e.id.startsWith("setting:wifi.networks."));
  t.true(passwords.length >= intent.wifi.networks.length);
  const home = passwords.find((e) => e.id === "setting:wifi.networks.0.password")!;
  t.is(home.title, "Password");
  t.true(home.context!.startsWith("Wi-Fi › "));
  t.true(home.context!.includes(intent.wifi.networks[0].ssid));
  t.is(home.url, "/settings/wifi/0?at=wifi.networks.0.password");
});

test("found by what OpenWrt calls it, and a section's setting says its section", (t) => {
  t.true(find(entries, "isolate").some((e) => e.id.endsWith(".isolate_clients")), "wifi-iface isolate");
  const login = entries.find((e) => e.id === "setting:system.app_login.password")!;
  t.is(login.context, "System › This app's login");
});

test("only where the settings hold its part, and never a value", (t) => {
  const line = intent.internet.lines.findIndex((l) => l.type !== "pppoe");
  t.false(entries.some((e) => e.id === `setting:internet.lines.${line}.pppoe.username`), "no PPPoE username on a line that is not PPPoE");
  const password = intent.wifi.networks[0].password;
  t.false(entries.some((e) => e.words.includes(password.toLowerCase())), "a Wi-Fi password is never searched");
});

test("the best match first: a title that is the query, then one that starts with it", (t) => {
  const [first] = find(entries, "name");
  t.is(first.title, "Name");
  t.deepEqual(find(entries, ""), []);
});
