import test from "ava";
import { assertSupportedRelease, compareReleases, supportedRelease } from "../../release";

test("25.12 and later are provisioned; older releases are refused up front", (t) => {
  for (const ok of ["25.12.0", "25.12.5", "25.12.0-rc1", "26.03.1", "SNAPSHOT"]) {
    t.true(supportedRelease(ok), ok);
  }
  for (const old of ["24.10.2", "23.05.5", "21.02.7", "25.10.0", "", "garbage"]) {
    t.false(supportedRelease(old), old);
  }
  t.throws(() => assertSupportedRelease("ap-1", "24.10.2"), {
    message: /ap-1 runs OpenWrt 24\.10\.2; this tool needs 25\.12 or later/,
  });
});

test("releases order by number, rc before release, snapshot after its line", (t) => {
  const ordered = ["24.10.2", "25.12.0-rc1", "25.12.0-rc2", "25.12.0", "25.12.5", "25.12.10", "25.12-SNAPSHOT", "26.03.0", "SNAPSHOT"];
  ordered.slice(1).forEach((newer, i) => t.is(compareReleases(ordered[i], newer), -1, `${ordered[i]} < ${newer}`));
  t.is(compareReleases("25.12", "25.12.0"), 0);
  t.is(compareReleases("garbage", "25.12.0"), undefined);
});
