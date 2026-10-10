import test from "ava";
import { posix } from "path";
import { dirname, join } from "../../paths";
import { decodeUtf8Hex, utf8ByteLength } from "../../utf8";

test("dirname matches path.posix.dirname", (t) => {
  for (const p of [
    "/etc/config/network",
    "/etc/",
    "/etc",
    "/",
    "a",
    "a/b",
    "a/b/",
    "./images/x.bin",
    "",
  ]) {
    t.is(dirname(p), posix.dirname(p), p);
  }
});

test("join resolves to the same path as path.posix.join", (t) => {
  for (const parts of [
    ["./images", "x.bin"],
    ["/home/u", ".ssh/id"],
    ["out/", "manifest.json"],
  ]) {
    t.is(
      posix.normalize(join(...parts)),
      posix.join(...parts),
      parts.join(" + ")
    );
  }
});

test("utf8ByteLength matches Buffer.byteLength", (t) => {
  for (const s of ["", "abc", "é", "€", "😀", "a\uD800b", "mixé€😀"]) {
    t.is(utf8ByteLength(s), Buffer.byteLength(s, "utf8"), JSON.stringify(s));
  }
});

test("decodeUtf8Hex decodes strictly", (t) => {
  t.is(
    decodeUtf8Hex(Buffer.from("pässwörd €😀").toString("hex")),
    "pässwörd €😀"
  );
  t.throws(() => decodeUtf8Hex("c0af")); // overlong '/'
  t.throws(() => decodeUtf8Hex("eda080")); // surrogate
  t.throws(() => decodeUtf8Hex("e282")); // truncated
});
