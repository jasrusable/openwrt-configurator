// Bundled and run under qjs by qjsParity.test.ts.
import "../../platforms/qjsGlobals";
import { qjsPlatform } from "../../platforms/qjs";
import { parityReport } from "./parityReport";

parityReport({ platform: qjsPlatform }).then(
  (report) => {
    console.log(report);
    qjsPlatform.exit(0);
  },
  (e) => {
    console.error(`parity report failed: ${(e as Error)?.message ?? e}`);
    qjsPlatform.exit(1);
  }
);
