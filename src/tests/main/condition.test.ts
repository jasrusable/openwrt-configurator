import test from "ava";
import { evaluateCondition, Lookup } from "../../condition";

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
    message: `Invalid condition "device.hostnmae == 'x'": unknown name device.hostnmae`,
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
