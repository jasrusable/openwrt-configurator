import test from "ava";
import { assertSupportedRelease, supportedRelease } from "../../release";

test("25.12 and later are provisioned; older releases are refused up front", (t) => {
  for (const ok of ["25.12.0", "25.12.5", "25.12.0-rc1", "26.03.1", "SNAPSHOT"]) {
    t.true(supportedRelease(ok), ok);
  }
  for (const old of ["24.10.2", "23.05.5", "21.02.7", "25.10.0", "", "garbage"]) {
    t.false(supportedRelease(old), old);
  }
  t.throws(() => assertSupportedRelease("jaculu-ap-1", "24.10.2"), {
    message: /jaculu-ap-1 runs OpenWrt 24\.10\.2; this tool needs 25\.12 or later/,
  });
});
