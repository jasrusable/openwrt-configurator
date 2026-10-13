import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { protocolRefreshCommands } from "../../getDeviceScript";
import { OpenWrtState } from "../../openWrtConfigSchema";
import { availability } from "../../intent/choices";
import { templateOf, withTemplate } from "../../intent/networkTemplates";
import { compileIntent } from "../../intent/compile";
import { ddnsService } from "../../intent/features/internet";
import { ovpnFile } from "../../intent/features/vpn";
import { ovpnUnsafe } from "../../intent/ovpn";
import { intentSchema } from "../../intent/schema";
import { clientAddresses, clientConf, decodeInvite, encodeInvite, inviteOf, nextClientHost, withPort } from "../../intent/vpn";
import { newPrivateKey, publicKeyOf } from "../../wireguard";
import { parseWgConf } from "../../wireguardConf";

const sample = () =>
  sampleIntent();

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
  const on = availability(intent, "vpn.remote_access.enabled").option(true).swap!.apply(intent);
  t.true(on.vpn.remote_access.enabled);
  t.truthy(on.vpn.remote_access.private_key);
  t.deepEqual(on.vpn.remote_access.access.networks, ["lan"], "the main network, to start");
  const clientKey = newPrivateKey();
  const client = { id: "c1", name: "Phone", public_key: publicKeyOf(clientKey), host: nextClientHost([])!, route: "home" as const };
  const file = parseWgConf(clientConf({ ...on, vpn: { ...on.vpn, remote_access: { ...on.vpn.remote_access, endpoint: "home.example.com" } } }, client, clientKey));
  t.is(file.peer.publicKey, publicKeyOf(on.vpn.remote_access.private_key!));
  t.is(file.peer.endpoint, "home.example.com:51820");
  t.deepEqual(file.addresses, clientAddresses(on, client).map((a, i) => `${a}/${i === 0 ? 32 : 128}`));
  t.deepEqual(file.dns, ["10.0.99.1"]);
  t.true(file.peer.allowedIps.includes("10.0.0.0/24"), "home's networks only");
});

test("a site's invitation carries what the other needs, and reads back the same", (t) => {
  const intent = sample();
  const site = {
    ...intent,
    vpn: { ...intent.vpn, sites: { ...intent.vpn.sites, private_key: newPrivateKey() } },
    internet: { ...intent.internet, dynamic_dns: { provider: "duckdns" as const, hostname: "home.duckdns.org", token: "x" } },
  };
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
  const parsed = intentSchema.safeParse({ ...intent, vpn: { ...intent.vpn, providers: [{ id: "tun1", name: "Bad", type: "openvpn", config }] } });
  t.false(parsed.success);
  t.regex(JSON.stringify(parsed.error?.issues), /may not set here.*script-security, up, plugin, log/);
  const file = ovpnFile({ id: "tun1", config });
  t.notRegex(file, /evil|\.so|shadow|script-security 2/);
  t.regex(file, /script-security 1\n/);
});

test("a site may claim only private ranges, none overlapping another site's or this one's", (t) => {
  const intent = sample();
  const key = publicKeyOf(newPrivateKey());
  const peer = (id: string, subnets: string[]) => ({ id, name: id, public_key: key, subnets });
  const issues = (peers: unknown[]) =>
    JSON.stringify(intentSchema.safeParse({ ...intent, vpn: { ...intent.vpn, sites: { private_key: newPrivateKey(), peers } } }).error?.issues ?? []);
  t.regex(issues([peer("s1", ["8.8.0.0/16"])]), /8\.8\.0\.0\/16 is not a private range/);
  t.regex(issues([peer("s1", ["10.9.0.0/16"]), peer("s2", ["10.9.1.0/24"])]), /10\.9\.1\.0\/24 overlaps s1's/);
  t.regex(issues([peer("s1", ["10.9.0.0/16"]), peer("s1", ["10.8.0.0/16"])]), /another has the id s1/);
  t.is(issues([peer("s1", ["10.9.0.0/16"]), peer("s2", ["100.64.1.0/24"])]), "[]");
});

test("a provider's DNS servers are IPv4: DHCP's option 6 takes nothing else, and dnsmasq would not start", (t) => {
  const tunnel = { id: "tun1", name: "P", type: "openvpn", config: "remote vpn.example.com 1194\n", dns: ["2001:db8::1"] };
  const s = sample();
  const r = intentSchema.safeParse({ ...s, vpn: { ...s.vpn, providers: [tunnel] } });
  t.true(!r.success && r.error.issues.some((i) => i.path.join(".") === "vpn.providers.0.dns.0"));
});

test("turning remote access off keeps networks' access to it, valid and not compiled", (t) => {
  const intent = sample();
  intent.networks[0].access.networks.push("vpn");
  intent.vpn.remote_access.enabled = false;
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
  const ok = (endpoint: string) => intentSchema.safeParse({ ...intent, vpn: { ...intent.vpn, remote_access: { ...intent.vpn.remote_access, endpoint } } }).success;
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

test("an .ovpn is read as OpenVPN reads it: quoted, --prefixed and setenv opt spellings are caught, a typical file passes", (t) => {
  t.deepEqual(ovpnUnsafe('client\nremote a.example.com 1194\n"plugin" /x.so\n--up /bin/sh\nsetenv opt up /bin/sh\nsetenv opt block-outside-dns\n'), ["plugin", "up"]);
  t.deepEqual(ovpnUnsafe("client\nremote a 1\n'replay-persist' /etc/x\nifconfig-pool-persist /etc/y\n"), ["replay-persist", "ifconfig-pool-persist"]);
  const typical = [
    "client", "dev tun", "proto udp", "remote nl1.example.com 1194", "resolv-retry infinite", "nobind",
    "persist-key", "persist-tun", "remote-cert-tls server", "cipher AES-256-GCM", "auth SHA512", "verb 3",
    "# a comment", "; another", "auth-user-pass", "<ca>", "-----BEGIN CERTIFICATE-----", "MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF", "-----END CERTIFICATE-----", "</ca>",
    "key-direction 1", "<tls-auth>", "#", "# 2048 bit OpenVPN static key", "#", "-----BEGIN OpenVPN Static key V1-----", "e685bdaf659a25a200e2b9e4c2ee2b9a", "-----END OpenVPN Static key V1-----", "</tls-auth>",
  ].join("\n");
  t.deepEqual(ovpnUnsafe(typical), [], "certificate content is data, not options");
  t.deepEqual(ovpnUnsafe("client\nremote a 1\n<script>\nx\n</script>\n"), ["script", "<script> content"], "an unknown block is refused");
});

test("an .ovpn may not read a file of the router's, nor blur where its key blocks end", (t) => {
  const base = "client\nremote a.example.com 1194\n";
  t.deepEqual(ovpnUnsafe(`${base}auth-user-pass /etc/shadow\n`), ["auth-user-pass from a file"]);
  t.deepEqual(ovpnUnsafe(`${base}ca /etc/ssl/x.pem\nhttp-proxy p 8080 /etc/shadow\n`), ["ca from a file", "http-proxy"]);
  t.deepEqual(ovpnUnsafe(`${base}auth-user-pass\ntls-auth [inline] 1\n`), [], "the console and inline are fine");
  t.deepEqual(ovpnUnsafe(`${base} <ca>\nup /bin/sh\n</ca>\n`), ["<ca>", "up", "</ca>"], "a tag that is not exact is no tag");
  t.deepEqual(ovpnUnsafe(`${base}<ca>\nMIIBIjANBgkqhkiG9w0BAQEFAAOC\nup /bin/sh\n</ca>\n`), ["<ca> content"]);
  // A quoted auth-user-pass is still the router's to set: stripped from what is written.
  const file = ovpnFile({ id: "tun1", config: `${base}"auth-user-pass"\n`, username: "u" });
  t.is(file.match(/auth-user-pass/g)?.length, 1);
  t.regex(file, /auth-user-pass \/etc\/openvpn\/tun1\.auth/);
});

test("remote access that may reach the linked sites: clients route to them, and the invitation asks them to route back", (t) => {
  const intent = sample();
  const remote = intent.vpn.remote_access;
  intent.vpn.remote_access = { ...remote, enabled: true, private_key: newPrivateKey(), access: { ...remote.access, networks: ["sites"] } };
  intent.vpn.sites = {
    ...intent.vpn.sites,
    private_key: newPrivateKey(),
    peers: [{ id: "s1", name: "Cabin", public_key: publicKeyOf(newPrivateKey()), subnets: ["192.168.50.0/24"] }],
  };
  const allowed = parseWgConf(clientConf(intent, { host: 2, route: "home" }, newPrivateKey())).peer.allowedIps;
  t.true(allowed.includes("192.168.50.0/24"));
  t.true(inviteOf(intent)!.subnets.includes(intent.vpn.remote_access.subnet));
  // Not when remote access may not reach them.
  intent.vpn.remote_access.access.networks = [];
  t.false(parseWgConf(clientConf(intent, { host: 2, route: "home" }, newPrivateKey())).peer.allowedIps.includes("192.168.50.0/24"));
  t.false(inviteOf(intent)!.subnets.includes(intent.vpn.remote_access.subnet));
});

test("an .ovpn line over 255 bytes is refused: OpenVPN would read its rest as another option", (t) => {
  const long = `remote vpn.example.com 1194 ${"x".repeat(240)}script-security 3`;
  t.deepEqual(ovpnUnsafe(`client\n${long}\n`), ["a line over 255 bytes"]);
  t.deepEqual(ovpnUnsafe("client\nremote vpn.example.com 1194\n"), []);
});
