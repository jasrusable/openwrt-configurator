// QuickJS entry point. Bundled to a single ES module; see `npm run bundle`.
import "../src/platforms/registerQjs";
import { run } from "../src/cli";

run(scriptArgs.slice(1));
