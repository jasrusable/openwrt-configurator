// QuickJS entry point. Bundled to a single ES module; see `npm run bundle`.
import "../src/platforms/qjsGlobals";
import { run } from "../src/cli";
import { qjsPlatform } from "../src/platforms/qjs";

run({ argv: scriptArgs.slice(1), platform: qjsPlatform });
