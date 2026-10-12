import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { protocolRefreshCommands } from "../../getDeviceScript";
import { OpenWrtState } from "../../openWrtConfigSchema";
import { availability } from "../../intent/choices";
import { templateOf, withTemplate } from "../../intent/networkTemplates";
import { compileIntent } from "../../intent/compile";
import { ddnsService } from "../../intent/features/internet";
import { ovpnFile } from "../../intent/features/vpn";
import { intentSchema } from "../../intent/schema";
import { clientAddresses, clientConf, decodeInvite, encodeInvite, inviteOf, nextClientHost, withPort } from "../../intent/vpn";
import { newPrivateKey, publicKeyOf } from "../../wireguard";
import { parseWgConf } from "../../wireguardConf";

const sample = () =>
  intentSchema.parse(JSON.parse(readFileSync(join(__dirname, "../../../sampleConfigs/intent.json"), "utf8")));

test("a provider's .conf, read: its key, address, DNS and server", (t) => {
  const conf = parseWgConf(
    [
      "[Interface]",
      "PrivateKey = cJ7JfTXu6Ys8Bv0JwzOjLFw7Es9mnTqOmhHKqaVFX2Q=",
      "Address = 10.64.12.34/32, fc00:bbbb::1/128",
      "DNS = 10.64.0.1",
      "",
      "[Peer]",
      "PublicKey = Xv/v0xP1d35+5fdEp4lGh6M5O3XvQbSzrKGm8U2C8Ck=",
      "AllowedIPs = 0.0.0.0/0, ::/0",
      "Endpoint = 185.65.134.10:51820 # a comment",
    ].join("\n")
  );
  t.deepEqual(conf.addresses, ["10.64.12.34/32", "fc00:bbbb::1/128"]);
  t.deepEqual(conf.dns, ["10.64.0.1"]);
  t.is(conf.peer.endpoint, "185.65.134.10:51820");
  t.throws(() => parseWgConf("[Peer]\nPublicKey = x"), { message: /PrivateKey/ });
});

test("turning remote access on makes the router's key; a client's file matches the router's peer for it", (t) => {
  const intent = sample();
  const on = availability(intent, "vpn.enabled").option(true).swap!.apply(intent);
  t.true(on.vpn.enabled);
  t.truthy(on.vpn.private_key);
  t.deepEqual(on.vpn.access.networks, ["lan"], "the main network, to start");
  const clientKey = newPrivateKey();
  const client = { id: "c1", name: "Phone", public_key: publicKeyOf(clientKey), host: nextClientHost([])!, route: "home" as const };
  const file = parseWgConf(clientConf({ ...on, vpn: { ...on.vpn, endpoint: "home.example.com" } }, client, clientKey));
  t.is(file.peer.publicKey, publicKeyOf(on.vpn.private_key!));
  t.is(file.peer.endpoint, "home.example.com:51820");
  t.deepEqual(file.addresses, clientAddresses(on, client).map((a, i) => `${a}/${i === 0 ? 32 : 128}`));
  t.deepEqual(file.dns, ["10.0.99.1"]);
  t.true(file.peer.allowedIps.includes("10.0.0.0/24"), "home's networks only");
});

test("a site's invitation carries what the other needs, and reads back the same", (t) => {
  const intent = sample();
  const site = { ...intent, sites: { ...intent.sites, private_key: newPrivateKey() }, internet: { ...intent.internet, ddns: { provider: "duckdns" as const, hostname: "home.duckdns.org", token: "x" } } };
  const invite = inviteOf(site)!;
  t.is(invite.endpoint, "home.duckdns.org:51821");
  t.deepEqual(decodeInvite(encodeInvite(invite)), invite);
  t.throws(() => decodeInvite("hello"), { message: /onc-site:/ });
});

test("netifd is restarted only for a protocol it may not know, on reload_config's own line", (t) => {
  const state = (protos: string[]) =>
    ({ config: { network: { interface: protos.map((proto) => ({ proto })) } } }) as unknown as OpenWrtState;
  t.deepEqual(protocolRefreshCommands(state(["none", "static", "dhcp", "dhcpv6"])), []);
  const [line] = protocolRefreshCommands(state(["static", "wireguard", "none"]));
  t.regex(line, /for p in 'wireguard'; do/);
  t.notRegex(line, /'none'/);
});

test("an .ovpn that would run or write things on the router is refused, and never written", (t) => {
  const intent = sample();
  const config = "client\nremote vpn.example.com 1194\nscript-security 2\nup /bin/evil.sh\n  plugin /x.so\nlog /etc/shadow\n";
  const parsed = intentSchema.safeParse({ ...intent, tunnels: [{ id: "tun1", name: "Bad", type: "openvpn", config }] });
  t.false(parsed.success);
  t.regex(JSON.stringify(parsed.error?.issues), /script-security, up, plugin, log/);
  const file = ovpnFile({ id: "tun1", config });
  t.notRegex(file, /evil|\.so|shadow|script-security 2/);
  t.regex(file, /script-security 1\n/);
});

test("a site may claim only private ranges, none overlapping another site's or this one's", (t) => {
  const intent = sample();
  const key = publicKeyOf(newPrivateKey());
  const peer = (id: string, subnets: string[]) => ({ id, name: id, public_key: key, subnets });
  const issues = (peers: unknown[]) =>
    JSON.stringify(intentSchema.safeParse({ ...intent, sites: { private_key: newPrivateKey(), peers } }).error?.issues ?? []);
  t.regex(issues([peer("s1", ["8.8.0.0/16"])]), /8\.8\.0\.0\/16 is not a private range/);
  t.regex(issues([peer("s1", ["10.9.0.0/16"]), peer("s2", ["10.9.1.0/24"])]), /10\.9\.1\.0\/24 overlaps s1's/);
  t.regex(issues([peer("s1", ["10.9.0.0/16"]), peer("s1", ["10.8.0.0/16"])]), /another has the id s1/);
  t.is(issues([peer("s1", ["10.9.0.0/16"]), peer("s2", ["100.64.1.0/24"])]), "[]");
});

test("a provider's DNS servers are IPv4: DHCP's option 6 takes nothing else, and dnsmasq would not start", (t) => {
  const tunnel = { id: "tun1", name: "P", type: "openvpn", config: "remote vpn.example.com 1194\n", dns: ["2001:db8::1"] };
  const r = intentSchema.safeParse({ ...sample(), tunnels: [tunnel] });
  t.true(!r.success && r.error.issues.some((i) => i.path.join(".") === "tunnels.0.dns.0"));
});

test("turning remote access off keeps networks' access to it, valid and not compiled", (t) => {
  const intent = sample();
  intent.networks[0].access.networks.push("vpn");
  intent.vpn.enabled = false;
  t.true(intentSchema.safeParse(intent).success);
  const config = compileIntent(intent);
  const forwardings = JSON.stringify(config.config.firewall?.forwarding ?? []);
  t.notRegex(forwardings, /"dest":"vpn"/);
});

test("dynamic DNS: Cloudflare's record@zone for deeper names, the main connection's interface", (t) => {
  const service = (hostname: string, zone?: string) =>
    ddnsService({ provider: "cloudflare", hostname, token: "t", ...(zone ? { zone } : {}) }, "wanb");
  t.is(service("vpn.home.example.com").domain, "vpn.home@example.com");
  t.is(service("example.com").domain, "@example.com");
  t.is(service("home.example.co.uk", "example.co.uk").domain, "home@example.co.uk");
  t.is(service("home.example.com").interface, "wanb");
});

test("remote access's address: a name or an address without a port; IPv6 bracketed in what clients get", (t) => {
  const intent = sample();
  const ok = (endpoint: string) => intentSchema.safeParse({ ...intent, vpn: { ...intent.vpn, endpoint } }).success;
  t.true(ok("home.example.com"));
  t.true(ok("203.0.113.7"));
  t.true(ok("2001:db8::7"));
  t.false(ok("home.example.com:51820"));
  t.is(withPort("2001:db8::7", 51820), "[2001:db8::7]:51820");
  t.is(withPort("home.example.com", 51820), "home.example.com:51820");
});

test("a network's template leaves its access to remote access and sites alone", (t) => {
  const intent = sample();
  intent.networks[1].access.networks.push("vpn");
  t.is(templateOf(intent.networks, 1), "guest");
  const home = withTemplate(intent, 1, "home");
  t.deepEqual(home.networks[1].access.networks, ["lan", "vpn"]);
  t.is(templateOf(home.networks, 1), "home");
});
