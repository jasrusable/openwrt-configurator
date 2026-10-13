// Measures under QuickJS what a status read spends on the settings before it
// reads any device: loading and compiling them, and each device's state.
// "cold" changes the file each round (as an edit would), "warm" leaves it, so
// the read's cache answers. Run by hand in the router container; not a test.
import "../../platforms/qjsGlobals";
import { qjsPlatform as platform } from "../../platforms/qjs";
import { readStatusSettings } from "../../status/read";

const [intentPath, rounds] = scriptArgs.slice(1);
const timed = async (n: number, before: (i: number) => void) => {
  const started = Date.now();
  for (let i = 0; i < n; i++) {
    before(i);
    const read = await readStatusSettings(intentPath, platform);
    if (!read.ok) throw new Error(read.error.message);
    read.value.ready.forEach((d) => read.value.expected(d.hostname));
  }
  return (Date.now() - started) / n;
};
const main = async () => {
  const n = Number(rounds ?? 10);
  const text = platform.readTextFile(intentPath);
  const cold = await timed(n, (i) => platform.writeTextFile(intentPath, text + " ".repeat(i + 1)));
  const warm = await timed(n, () => {});
  platform.writeTextFile(intentPath, text);
  console.log(`cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms per read (${n} rounds)`);
};
main().catch((e) => console.log(`FAILED ${e?.message ?? e}`));
