// DNS that does not hang on one provider, devices kept on the router's DNS,
// and providers' tunnels as their files say (MTU), re-resolved when dialled
// by name.
import test from "ava";
import { compileIntent } from "../../intent/compile";
import { fallbackOf } from "../../intent/dns/compile";
import { Intent, intentSchema } from "../../intent/schema";
import { printPlan } from "../../lowLevel/print";
import { newPrivateKey, publicKeyOf } from "../../wireguard";
import { formatWgConf, parseWgConf } from "../../wireguardConf";
import { sampleIntent } from "../helpers/fixtures";

/** The compiled low-level config, as JSON text to search. */
const compiled = (intent: Intent) => printPlan(compileIntent(intent));
const sections = (intent: Intent, config: string, type: string) =>
  ((compiled(intent).config as Record<string, Record<string, Record<string, unknown>[]>>)[config]?.[type] ?? []);

const encrypted = (fallback?: "cloudflare" | "google" | "quad9" | "none"): Intent => {
  const intent = sampleIntent();
  return intentSchema.parse({ ...intent, dns: { ...intent.dns, upstream: { type: "encrypted", provider: "cloudflare", ...(fallback ? { fallback } : {}) } } });
};

test("encrypted DNS has a fallback provider, asked only when the first does not answer", (t) => {
  const proxies = sections(encrypted(), "https-dns-proxy", "https-dns-proxy");
  t.deepEqual(
    proxies.map((p) => [p.resolver_url, p.listen_port]),
    [
      ["https://cloudflare-dns.com/dns-query", "5053"],
      ["https://dns.quad9.net/dns-query", "5054"],
    ]
  );
  const [dnsmasq] = sections(encrypted(), "dhcp", "dnsmasq");
  t.deepEqual(dnsmasq.server, ["127.0.0.1#5053", "127.0.0.1#5054"], "the provider first");
  t.is(dnsmasq.strictorder, true, "in that order: the fallback sees nothing while the provider answers");
});

test("the fallback: chosen, automatic (another provider), or none", (t) => {
  t.is(fallbackOf({ type: "encrypted", provider: "quad9" }), "cloudflare");
  t.is(fallbackOf({ type: "encrypted", provider: "google" }), "quad9");
  t.is(fallbackOf({ type: "encrypted", provider: "cloudflare", fallback: "google" }), "google");
  const alone = encrypted("none");
  t.is(sections(alone, "https-dns-proxy", "https-dns-proxy").length, 1);
  const [dnsmasq] = sections(alone, "dhcp", "dnsmasq");
  t.deepEqual(dnsmasq.server, ["127.0.0.1#5053"]);
  t.false("strictorder" in dnsmasq);
  const same = intentSchema.safeParse({ ...alone, dns: { ...alone.dns, upstream: { type: "encrypted", provider: "cloudflare", fallback: "cloudflare" } } });
  t.true(!same.success && same.error.issues.some((i) => i.path.join(".") === "dns.upstream.fallback"), "not the provider itself");
});

test("a network kept on the router's DNS: plain DNS answered by the router, DNS over TLS refused, browsers told", (t) => {
  const intent = sampleIntent();
  const guest = intent.networks.findIndex((n) => n.vlan !== undefined);
  intent.networks[guest].keep_dns = true;
  const id = intent.networks[guest].id;
  t.like(sections(intent, "firewall", "redirect").find((r) => r.name === `Keep-${id}-DNS`), {
    src: id,
    src_dport: "53",
    target: "DNAT",
    family: "any",
  });
  t.like(sections(intent, "firewall", "rule").find((r) => r.name === `Keep-${id}-DNS-over-TLS`), {
    src: id,
    dest: "wan",
    dest_port: "853",
    target: "REJECT",
  });
  const [dnsmasq] = sections(intent, "dhcp", "dnsmasq");
  t.deepEqual(
    (dnsmasq.server as string[]).filter((s) => s.startsWith("/")),
    ["/use-application-dns.net/", "/mask.icloud.com/", "/mask-h2.icloud.com/"]
  );
  const rules = sections(intent, "firewall", "rule").map((r) => r.name);
  t.true(rules.indexOf(`Keep-${id}-DNS-over-TLS`) > rules.indexOf("Allow-DHCP-Renew"), "after the firewall's own rules");
  // Off: nothing of it.
  const plain = compiled(sampleIntent());
  t.notRegex(JSON.stringify(plain), /Keep-|use-application-dns/);
});

test("keeping a network on the router's DNS is refused where its devices are meant to use other servers", (t) => {
  const intent = sampleIntent();
  const guest = intent.networks.findIndex((n) => n.vlan !== undefined);
  const piHole = structuredClone(intent);
  piHole.networks[guest] = { ...piHole.networks[guest], keep_dns: true, dhcp: { ...piHole.networks[guest].dhcp, dns_servers: ["10.0.0.53"] } };
  const r = intentSchema.safeParse(piHole);
  t.true(!r.success && r.error.issues.some((i) => i.path.join(".") === `networks.${guest}.keep_dns` && /other DNS servers/.test(i.message)));
});

test("a provider's .conf MTU is kept: read, written back, and on its interface", (t) => {
  const key = newPrivateKey();
  const conf = parseWgConf(
    ["[Interface]", `PrivateKey = ${key}`, "Address = 10.64.0.2/32", "MTU = 1320", "", "[Peer]", `PublicKey = ${publicKeyOf(newPrivateKey())}`, "Endpoint = vpn.example.com:51820", "AllowedIPs = 0.0.0.0/0"].join("\n")
  );
  t.is(conf.mtu, 1320);
  t.is(parseWgConf(formatWgConf(conf)).mtu, 1320, "round trip");
  const intent = intentSchema.parse({
    ...sampleIntent(),
    vpn: {
      ...sampleIntent().vpn,
      providers: [
        { id: "tun1", name: "Provider", type: "wireguard", private_key: key, address: "10.64.0.2/32", mtu: 1320, peer: { public_key: conf.peer.publicKey, endpoint: "vpn.example.com:51820" } },
      ],
    },
  });
  t.like(sections(intent, "network", "interface").find((i) => i[".name"] === "tun1"), { proto: "wireguard", mtu: 1320 });
  t.like(sections(intent, "firewall", "zone").find((z) => z.name === "tun1"), { mtu_fix: true });
});

test("a WireGuard peer dialled by name is looked up again by the watchdog; by address, cron is left alone", (t) => {
  const withProvider = (endpoint: string) =>
    intentSchema.parse({
      ...sampleIntent(),
      vpn: {
        ...sampleIntent().vpn,
        providers: [
          { id: "tun1", name: "Provider", type: "wireguard", private_key: newPrivateKey(), address: "10.64.0.2/32", peer: { public_key: publicKeyOf(newPrivateKey()), endpoint } },
        ],
      },
    });
  const byName = compiled(withProvider("vpn.example.com:51820"));
  const crontab = byName.files?.find((f) => f.path === "/etc/crontabs/root");
  t.is(crontab?.content, "* * * * * /usr/bin/wireguard_watchdog\n");
  t.true(byName.services?.some((s) => s.name === "cron" && s.running) ?? false);
  for (const endpoint of ["185.65.134.10:51820", "[2001:db8::1]:51820"]) {
    const byAddress = compiled(withProvider(endpoint));
    t.false(byAddress.files?.some((f) => f.path === "/etc/crontabs/root") ?? false, endpoint);
    t.false(byAddress.services?.some((s) => s.name === "cron") ?? false, endpoint);
  }
});
