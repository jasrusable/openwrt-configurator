import test from "ava";
import { parseCondition } from "../../condition";
import { evaluateChecked, Lookup } from "../../plan/when";

/** Whether a condition as written holds (its names checked as it is read, then each looked up). */
const evaluateCondition = (condition: string, lookup: Lookup) => evaluateChecked(parseCondition(condition), lookup);

const device: Record<string, string | boolean | string[]> = {
  "device.hostname": "jason's ap",
  "device.sw_config": false,
  "device.tag.role": "ap",
  "device.tag.site": "my house",
  "device.tag.vlans": ["iot", "guest"],
};
const lookup: Lookup = (name) => {
  if (name.startsWith("device.tag.")) return { value: device[name] as any };
  if (name in device) return { value: device[name] as any };
  throw new Error(`unknown name ${name}`);
};
const check = (condition: string) => evaluateCondition(condition, lookup);

test("the existing syntax still works", (t) => {
  t.true(check("device.tag.role == 'ap'"));
  t.false(check("device.tag.role == 'router'"));
  t.true(check("device.tag.role != 'router'"));
  t.true(check("device.sw_config == false"));
  t.true(check("device.tag.role=='ap'"));
  t.true(check("*"));
  // AND binds tighter than OR, as boolean-parser had it.
  t.true(
    check(
      "device.tag.role == 'router' AND device.sw_config == true OR device.tag.role == 'ap'"
    )
  );
});

test("strings keep their spaces and take escapes", (t) => {
  t.true(check("device.tag.site == 'my house'"));
  t.false(check("device.tag.site == 'myhouse'"));
  t.true(check("device.hostname == 'jason\\'s ap'"));
  t.true(check('device.hostname == "jason\'s ap"'));
});

test("a tag the device does not set is absent, not an error", (t) => {
  t.false(check("device.tag.floor == '2'"));
  t.true(check("device.tag.floor != '2'"));
  t.false(check("device.tag.floor in ['1', '2']"));
});

test("not, parentheses, in, and either spelling of the operators", (t) => {
  t.true(check("NOT device.tag.role == 'router'"));
  t.true(check("!(device.tag.role == 'router')"));
  t.true(check("device.tag.role in ['ap', 'switch']"));
  t.true(
    check("device.tag.vlans in ['lan', 'guest']"),
    "array tags match on any overlap"
  );
  t.true(
    check("device.tag.vlans == 'iot'"),
    "== on an array tag means contains"
  );
  t.true(
    check(
      "(device.tag.role == 'router' || device.tag.role == 'ap') && device.sw_config == false"
    )
  );
  t.true(check("device.tag.role == 'ap' and not device.tag.site == 'office'"));
});

test("mistakes are reported with the condition and a position", (t) => {
  t.throws(() => check("device.hostnmae == 'x'"), {
    message: /^Invalid condition "device\.hostnmae == 'x'": unknown name device\.hostnmae; use device\.tag\.<key> or one of /,
  });
  t.throws(() => check("device.tag.role = 'ap'"), {
    message: /unexpected "=" at column 17/,
  });
  t.throws(() => check("device.tag.role == 'ap"), {
    message: /unterminated string at column 20/,
  });
  t.throws(() => check("device.tag.role == 'ap' AND"), {
    message: /expected a name .* at the end/,
  });
  t.throws(() => check("(device.tag.role == 'ap'"), {
    message: /expected "\)" at the end/,
  });
});

test("releases compare as releases", (t) => {
  const on = (version: string, condition: string) =>
    evaluateCondition(condition, (name) => ({ value: name === "device.version" ? version : undefined }));
  t.true(on("25.12.5", "device.version < '25.12.6'"));
  t.false(on("25.12.6", "device.version < '25.12.6'"));
  t.true(on("25.12.10", "device.version > '25.12.9'"), "numerically, not as text");
  t.true(on("25.12.0-rc1", "device.version < '25.12.0'"), "an rc before its release");
  t.true(on("25.12-SNAPSHOT", "device.version > '25.12.9'"), "a branch snapshot after its releases");
  t.true(on("SNAPSHOT", "device.version >= '26.03'"), "main's snapshot after everything");
  t.true(on("25.12.0", "device.version <= 25.12"), "25.12 is 25.12.0");
  t.true(on("25.10.1", "device.version >= 25.10"), "a number literal kept as written: 25.10, not 25.1");
  t.false(on("garbage", "device.version < '25.12.6'"), "not a release: matches nothing");
  t.false(on("garbage", "device.version >= '25.12.6'"));
  t.false(check("device.tag.missing < '1'"), "absent: matches nothing");
  t.true(on("25.12.5", "device.version >= '25.12' AND device.version < '25.12.6'"));
  t.throws(() => check("device.version < true"), { message: /expected a release/ });
});

test("an unquoted number compares as written", (t) => {
  const tagged = (value: string): Lookup => (name) => (name === "device.tag.x" ? { value } : { value: undefined });
  t.true(evaluateCondition("device.tag.x == 25.10", tagged("25.10")));
  t.false(evaluateCondition("device.tag.x == 25.10", tagged("25.1")));
  t.true(evaluateCondition("device.tag.x in [01, 2]", tagged("01")));
  t.false(evaluateCondition("device.tag.x == 01", tagged("1")));
});

test("a condition's values compare by text, and a mistyped name fails even where OR would skip it", (t) => {
  const lookup = (name: string) => {
    if (name === "device.sw_config") return { value: true };
    if (name === "device.tag.floor") return { value: "2" };
    if (name === "device.tag.role") return { value: "ap" };
    if (name.startsWith("device.tag.")) return {};
    throw new Error(`unknown name ${name}`);
  };
  t.true(evaluateCondition("device.sw_config == 'true'", lookup));
  t.true(evaluateCondition("device.tag.floor == 2", lookup));
  t.throws(() => evaluateCondition("device.tag.role == 'ap' OR device.modle_id == 'x'", lookup), { message: /modle_id/ });
});

test("a condition tree prints as the language and reads back as itself", (t) => {
  const { when, printWhen } = require("../../plan/when");
  const { parseCondition } = require("../../condition");
  const trees = [
    when.always,
    when.all(),
    when.any(),
    when.role("router"),
    when.all(when.role("router"), when.any(when.radio("2g"), when.radio("5g"))),
    when.not(when.all(when.swConfig(false), when.device("ap's"))),
    when.all(when.oneOf("device.model_id", ["a", "b"]), when.order("device.version", "<", "25.12.6")),
  ];
  for (const tree of trees) t.deepEqual(parseCondition(printWhen(tree)), tree, printWhen(tree));
  t.is(printWhen(when.all()), "*", "nothing to hold: every device");
});
