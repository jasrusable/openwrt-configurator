import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { availability } from "../../intent/choices";
import { intentSchema } from "../../intent/schema";
import { clientAddresses, clientConf, decodeInvite, encodeInvite, inviteOf, nextClientHost } from "../../intent/vpn";
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
