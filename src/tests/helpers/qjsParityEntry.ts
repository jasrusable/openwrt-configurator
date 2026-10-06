// Bundled and run under qjs by qjsParity.test.ts.
import "../../platforms/registerQjs";
import { platform } from "../../platform";
import { parityReport } from "./parityReport";

parityReport().then(
  (report) => {
    console.log(report);
    platform().exit(0);
  },
  (e) => {
    console.error(`parity report failed: ${(e as Error)?.message ?? e}`);
    platform().exit(1);
  }
);
