// 25.12's mwan3 answers bare `nan` for a line online since boot
// (https://github.com/openwrt/packages/issues/29653): every line must still read.
import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { mwan3, parseLines, withoutBareNumbers } from "../../status/device/internet";

const recorded = readFileSync(join(__dirname, "../helpers/status/mwan3-status-nan.txt"), "utf8");

test("mwan3's bare nan values read as nothing, and every line's state still reads", (t) => {
  const status = mwan3.parse({ stdout: recorded, stderr: "", code: 0 });
  t.deepEqual(parseLines(status), [
    { id: "wan", state: "online", since: 0 },
    { id: "wanb", state: "offline", since: 12 },
  ]);
});

test("only bare values change: text that says nan, and numbers, stay as they are", (t) => {
  t.is(withoutBareNumbers('{"a": nan, "b": [inf, -nan], "c": "nan", "d": 1.5, "nanny": 2}'), '{"a": null, "b": [null, null], "c": "nan", "d": 1.5, "nanny": 2}');
});
