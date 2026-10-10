import test from "ava";
import { nodePlatform } from "../../platforms/node";

// A program that exits without reading its input closes the pipe before the
// write lands. Node reports that as an unhandled EPIPE on stdin and crashed
// the whole CLI; the rig hit it with `ip route` during gateway detection.
test("run survives a program that ignores its stdin", async (t) => {
  for (let i = 0; i < 50; i++) {
    const result = await nodePlatform.run(["true"], { stdin: "x".repeat(200000) });
    t.is(result.code, 0);
  }
});
