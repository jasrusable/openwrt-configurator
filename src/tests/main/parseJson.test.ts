import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { findJsonError, parseConfigJson, parseJson } from "../../parseJson";

const errorOf = (text: string) => {
  try {
    parseJson(text, "net.json");
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a parse failure");
};

test("valid JSON parses", (t) => {
  t.deepEqual(parseJson('{"a": [1, -2.5e3, true, null, "x\\n\\u00e9"]}'), {
    a: [1, -2500, true, null, "x\né"],
  });
});

test("errors name the file, line and column", (t) => {
  const message = errorOf('{\n  "a": 1,\n  "b": tru\n}');
  t.true(message.startsWith("net.json:3:8: Unexpected"), message);
  t.true(message.includes('  "b": tru\n         ^'), message);
});

test("a trailing comma is called out", (t) => {
  t.true(
    errorOf('{"a": 1,\n}').includes("net.json:2:1: Trailing comma before '}'")
  );
  t.true(errorOf("[1, 2, ]").includes("Trailing comma before ']'"));
});

test("common hand-editing mistakes are located", (t) => {
  t.regex(errorOf("{a: 1}"), /:1:2: Expected a double-quoted property name/);
  t.regex(errorOf('{"a" 1}'), /:1:6: Expected ':'/);
  t.regex(errorOf('{"a": 1 "b": 2}'), /:1:9: Expected ','/);
  t.regex(errorOf('{"a": "x'), /Unterminated string/);
  t.regex(errorOf(""), /:1:1: Unexpected end of input/);
  t.regex(errorOf('{"a": 1}}'), /after the end of the JSON value/);
});

// The scanner only runs once JSON.parse has failed, so it must agree with
// JSON.parse on what is valid — otherwise a real error goes unlocated, or a
// valid file is reported as broken.
test("the scanner agrees with JSON.parse on mutated real configs", (t) => {
  const root = join(__dirname, "../../..");
  const fixtures = [
    "sampleConfigs/basic.json",
    "src/tests/main/config.json",
    "src/tests/main/config2.json",
    "deviceSchemas/ubnt,edgerouter-x.json",
  ].map((path) => readFileSync(join(root, path), "utf-8"));

  let seed = 42;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const alphabet = ' {}[],:"\\0123456789-.eEtrufalsn\n\tx';

  let disagreements = 0;
  for (let k = 0; k < 2000; k++) {
    const text = fixtures[k % fixtures.length];
    const at = random(text.length);
    const op = random(3);
    const ch = alphabet[random(alphabet.length)];
    const mutated =
      op === 0
        ? text.slice(0, at) + text.slice(at + 1)
        : op === 1
        ? text.slice(0, at) + ch + text.slice(at)
        : text.slice(0, at) + ch + text.slice(at + 1);
    let valid = true;
    try {
      JSON.parse(mutated);
    } catch {
      valid = false;
    }
    if (valid !== (findJsonError(mutated) === undefined)) disagreements++;
  }
  t.is(disagreements, 0);
});

test("config files may carry comments and trailing commas", (t) => {
  const text = [
    "{",
    "  // the router",
    '  "url": "https://example.com/feed", /* inline */',
    '  "list": [1, 2,],',
    "}",
  ].join("\n");
  t.deepEqual(parseConfigJson(text, "net.json"), {
    url: "https://example.com/feed",
    list: [1, 2],
  });
});

test("config file errors are still located, after comments", (t) => {
  const text = '{\n  // a comment\n  "a": 1\n  "b": 2\n}';
  const error = t.throws(() => parseConfigJson(text, "net.json"));
  t.true(
    error!.message.startsWith("net.json:4:3: Expected ','"),
    error!.message
  );
});

test("strict JSON still rejects comments", (t) => {
  t.throws(() => parseJson('{ // no\n "a": 1 }'), { message: /:1:3:/ });
});
