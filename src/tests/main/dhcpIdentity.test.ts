// The DHCP clients identify by MAC: no dhcp_default_duid is declared, so the
// random one 25.12 makes at first boot is wiped and none replaces it
// (src/intent/networks/compile.ts says why).
import test from "ava";
import { compileIntent } from "../../intent/compile";
import { sampleIntent } from "../helpers/fixtures";

test("no default DUID is declared on any device: DHCP identity stays the MAC", (t) => {
  const plan = compileIntent(sampleIntent());
  const globals = plan.config.network?.globals ?? [];
  t.is(globals.length, 1);
  const values = [globals[0].options, ...(globals[0].overrides ?? []).map((o) => o.options)];
  t.false(values.some((o) => "dhcp_default_duid" in o));
});
