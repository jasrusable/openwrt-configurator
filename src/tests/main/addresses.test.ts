import test from "ava";
import {
  isAddressOrRange,
  isIpv6Address,
  isPortRange,
  networkHolding,
  parseIpv4,
  rangeOf,
} from "../../intent/addresses";
import { parseSubnet } from "../../intent/validators";

test("addresses and ranges are checked as nft and fw4 take them, not by shape", (t) => {
  for (const ok of ["10.0.0.5", "10.0.0.0/24", "0.0.0.0/0", "10.0.0.5/32", "2001:db8::1", "2001:db8::/64", "::1", "::", "fe80::1/128", "1:2:3:4:5:6:7:8"]) {
    t.true(isAddressOrRange(ok), ok);
  }
  // A prefix too long for its family makes nft refuse the whole ruleset; an
  // octet over 255 makes fw4 skip the rule (verified on 25.12.5).
  for (const bad of ["10.0.0.5/99", "10.0.0.5/33", "300.1.1.1", "10.0.0", "2001:db8::/129", "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "1::2::3", "10.0.0.1/24/8", "10.0.0.1/", "abc", ""]) {
    t.false(isAddressOrRange(bad), bad);
  }
  t.true(isIpv6Address("2001:db8::1:2:3:4"));
  t.false(isIpv6Address("10.0.0.1"));
  t.is(parseIpv4("10.0.0.999"), undefined);
  // musl's inet_pton (OpenWrt's) refuses a leading zero, and 010 would read as another network's text.
  for (const bad of ["010.0.0.1", "10.00.0.1", "10.0.0.01", "10.0.0.0/024"]) t.false(isAddressOrRange(bad), bad);
  t.is(parseSubnet("010.0.0.0/24"), undefined);
  t.deepEqual(parseSubnet("10.0.0.0/24"), [10, 0, 0]);
  t.is(rangeOf("10.64.0.2/24"), "10.64.0.0/24");
  t.is(rangeOf("10.64.0.2/32"), "10.64.0.2/32");
});

test("ports are 1 to 65535, a range low to high", (t) => {
  for (const ok of ["1", "443", "65535", "8000-8100", "80-80"]) t.true(isPortRange(ok), ok);
  for (const bad of ["0", "65536", "99999", "8100-8000", "80-", "-80", "1-2-3", "a"]) t.false(isPortRange(bad), bad);
});

test("the network holding an address is found by its range, whatever the range's size", (t) => {
  const networks = [{ id: "lan", subnet: "10.0.0.0/24" }, { id: "guest", subnet: "10.0.10.0/24" }];
  t.is(networkHolding(networks, "10.0.10.7")?.id, "guest");
  t.is(networkHolding(networks, "10.0.1.7"), undefined);
  t.is(networkHolding(networks, "10.0.0.999"), undefined);
});
