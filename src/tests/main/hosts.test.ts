import test from "ava";
import { hostAllowed, routerNames } from "../../server/hosts";

test("the CGI answers only to the router's addresses and names, so a rebound name is refused", (t) => {
  const names = routerNames({
    hardware: [{ name: "gateway", role: "router" }, { name: "ap-1", role: "access-point" }],
    dns: { domain: "home.arpa" },
    internet: { dynamic_dns: { hostname: "home.example.com" } },
  });
  for (const host of ["10.0.0.1", "10.0.0.1:443", "[fd00::1]", "[fd00::1]:8443", "gateway", "Gateway.home.arpa", "gateway.home.arpa.", "home.example.com", "openwrt.home.arpa"]) {
    t.true(hostAllowed(host, names), host);
  }
  for (const host of [undefined, "", "evil.example", "evil.example:443", "ap-1", "gateway.evil.example", "10.0.0.1.evil.example"]) {
    t.false(hostAllowed(host, names), String(host));
  }
  t.true(hostAllowed("openwrt.lan", routerNames(undefined)), "an unreadable intent still has OpenWrt's defaults");
});
