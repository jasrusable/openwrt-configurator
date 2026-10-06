import test from "ava";
import { posix } from "path";
import { dirname, join } from "../../paths";

test("dirname matches path.posix.dirname", (t) => {
  for (const p of ["/etc/config/network", "/etc/", "/etc", "/", "a", "a/b", "a/b/", "./images/x.bin", ""]) {
    t.is(dirname(p), posix.dirname(p), p);
  }
});

test("join resolves to the same path as path.posix.join", (t) => {
  for (const parts of [["./images", "x.bin"], ["/home/u", ".ssh/id"], ["out/", "manifest.json"]]) {
    t.is(posix.normalize(join(...parts)), posix.join(...parts), parts.join(" + "));
  }
});
