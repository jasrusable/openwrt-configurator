import test from "ava";
import { slug, uniqueNames } from "../../intent/names";

test("names from what items are: a repeat takes the first name no other item has", (t) => {
  t.deepEqual(uniqueNames("rule", ["Web", "Web", "Web 2"], (n) => n), ["rule_web", "rule_web_2", "rule_web_2_2"]);
  t.deepEqual(uniqueNames("rule", ["Web 2", "Web", "Web"], (n) => n), ["rule_web_2", "rule_web", "rule_web_3"]);
});

test("a slug keeps accented letters, and is never empty", (t) => {
  t.is(slug("Café Wi-Fi"), "cafe_wi_fi");
  t.is(slug("家"), "x");
});
