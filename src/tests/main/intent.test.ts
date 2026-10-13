import test from "ava";
import { sampleIntentJson } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { getOpenWrtState } from "../../getOpenWrtState";
import { availability } from "../../intent/choices";
import { withMain, withoutConnection } from "../../intent/connections";
import { compileIntent } from "../../intent/compile";
import { rescueAfterMinutes } from "../../intent/features/mesh";
import { ulaPrefix } from "../../intent/features/network";
import { migrateIntent } from "../../intent/migrations";
import { Intent, intentSchema } from "../../intent/schema";
import { oncConfigSchema } from "../../oncConfigSchema";

const root = join(__dirname, "../../..");
const sample = () =>
  sampleIntentJson();
const compile = (intent = sample()) =>
  oncConfigSchema.parse(compileIntent(intentSchema.parse(intent)));

// Real hardware, captured read-only from the user's devices: the compiled
// config must resolve on each, exactly as a hand-written one would.
const onDevice = (hostname: string, model: string, intent = sample()) => {
  const oncConfig = compile(intent);
  const deviceSchema = deviceSchemaSchema.parse(
    JSON.parse(
      readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8")
    )
  );
  const deviceConfig = oncConfig.devices.find((d) => d.hostname === hostname)!;
  return getOpenWrtConfig({ oncConfig, deviceConfig, deviceSchema }) as any;
};

test("the sample intent compiles to a valid low-level config", (t) => {
  const config = compile();
  t.deepEqual(
    config.devices.map((d) => [d.hostname, d.tags.role, d.ipaddr]),
    [
      ["home-router", "router", "10.0.0.1"],
      ["home-ap-1", "access-point", "home-ap-1.lan"],
    ]
  );
  // No device facts: the model is read from the device when provisioning.
  t.true(config.devices.every((d) => d.model_id === undefined));
});

test("on the router: WAN on the board's WAN port, everything else bridged", (t) => {
  const config = onDevice("home-router", "friendlyarm,nanopi-r6s");
  const wan = config.network.interface.find((i: any) => i[".name"] === "wan");
  t.is(wan.device, "eth1", "@wan_port is the port board.json calls wan");
  t.is(config.sqm.queue[0].interface, "eth1");
  t.is(config.sqm.queue[0].download, "950000");
  t.deepEqual(config.network.device[0].ports, ["eth0", "eth2"]);
  // Every LAN port a trunk: the main network untagged, guests tagged.
  t.deepEqual(
    config.network["bridge-vlan"].map((v: any) => [v.vlan, v.ports]),
    [
      [1, ["eth0", "eth2"]],
      [20, ["eth0:t", "eth2:t"]],
    ]
  );
  t.deepEqual(config.dhcp.dnsmasq[0].server, ["127.0.0.1#5053"]);
  t.is(wan.peerdns, false, "encrypted DNS ignores the ISP's resolvers");
  t.is(config.system.system[0].timezone, "CET-1CEST,M3.5.0,M10.5.0/3");
  t.false("wireless" in config, "the router has no radios and no Wi-Fi");
});

test("on the router: each network routed, served and firewalled by purpose", (t) => {
  const config = onDevice("home-router", "friendlyarm,nanopi-r6s");
  const iface = (name: string) =>
    config.network.interface.find((i: any) => i[".name"] === name);
  t.like(iface("lan"), { device: "br-lan.1", proto: "static", ipaddr: "10.0.0.1" });
  t.like(iface("guest"), { device: "br-lan.20", proto: "static", ipaddr: "10.0.20.1" });
  t.is(iface("guest").ip6assign, undefined, "IPv6 is off on the guest network");
  t.deepEqual(
    config.dhcp.dhcp.map((d: any) => [d.interface, d.start, d.limit]),
    [
      ["lan", 5, 250],
      ["guest", 155, 100],
      ["wan", undefined, undefined],
    ]
  );
  t.true(config.dhcp.dhcp[2].ignore, "as stock: no DHCP on an internet line");
  // As stock 25.12: one instance on every attached network, leases in RAM.
  t.like(config.dhcp.dnsmasq[0], { localservice: true, nonwildcard: true, boguspriv: true, ednspacket_max: 1232, cachesize: 1000, leasefile: "/tmp/dhcp.leases" });
  t.is(config.dhcp.dnsmasq[0].interface, undefined);
  // Home reaches everything; guests only the internet and the router's
  // DHCP and DNS.
  t.deepEqual(
    config.firewall.forwarding.map((f: any) => `${f.src}->${f.dest}`),
    ["lan->wan", "lan->guest", "guest->wan"]
  );
  const zone = (name: string) => config.firewall.zone.find((z: any) => z.name === name);
  t.is(zone("lan").input, "ACCEPT");
  t.is(zone("guest").input, "REJECT");
  t.deepEqual(
    config.firewall.rule.filter((r: any) => r.src === "guest").map((r: any) => r.name),
    [
      "Guests may print",
      "Allow-guest-DHCP",
      "Allow-guest-DHCPv6",
      "Allow-guest-DNS",
      "Allow-guest-NTP",
      "Allow-guest-ICMPv6",
    ]
  );
  t.like(
    config.firewall.rule.find((r: any) => r.name === "Guests may print"),
    { src: "guest", dest: "lan", dest_ip: ["10.0.0.20"], proto: ["tcp"], dest_port: "631 9100", target: "ACCEPT" }
  );
  // OpenWrt's stock WAN rules are always there.
  t.true(config.firewall.rule.some((r: any) => r.name === "Allow-Ping"));
  // Time from the router, on every network: the firewall decides who asks.
  t.false("interface" in config.system.timeserver[0]);
  // A port forward lands in the zone of the network its target is on.
  t.like(config.firewall.redirect[0], {
    name: "Game server",
    target: "DNAT",
    src: "wan",
    src_dport: "27015",
    proto: ["udp"],
    dest: "lan",
    dest_ip: "10.0.0.50",
    dest_port: "27015",
  });
});

test("the firewall derives from each network's access; own rules come first", (t) => {
  const intent = sample();
  intent.networks[1].access = { internet: false, networks: ["lan"], router: "full" };
  intent.firewall.rules.push(
    { name: "No IoT out", from: "guest", to: "internet", protocol: "any", action: "block" },
    { name: "Scanners", from: "internet", to: "*", from_addresses: ["2001:db8::/32"], action: "block" }
  );
  const fw = (compile(intent).config as any).firewall;
  t.deepEqual(
    fw.forwarding.map((f: any) => `${f.src}->${f.dest}`),
    ["lan->wan", "lan->guest", "guest->lan"],
    "no internet for guests now, and they reach home"
  );
  t.like(fw.zone.find((z: any) => z.name === "guest"), { input: "ACCEPT", forward: "REJECT" });
  t.false(fw.rule.some((r: any) => r.name === "Allow-guest-DNS"), "full access needs no service rules");
  t.like(fw.zone.find((z: any) => z.name === "wan"), {
    masq: true,
    mtu_fix: true,
    network: ["wan", "wan6"],
  });
  const names = fw.rule.map((r: any) => r.name);
  t.deepEqual(names.slice(0, 3), ["Guests may print", "No IoT out", "Scanners"], "own rules first, in order: fw4 stops at the first match");
  t.is(names[3], "Allow-DHCP-Renew", "then the stock rules");
  t.like(fw.rule.find((r: any) => r.name === "No IoT out"), { src: "guest", dest: "wan", proto: ["all"], target: "REJECT" });
  t.like(fw.rule.find((r: any) => r.name === "Scanners"), {
    src: "wan",
    dest: "*",
    proto: ["tcp", "udp"],
    family: "ipv6",
    target: "DROP",
  });
  t.like(fw.rule.find((r: any) => r.name === "Allow-ICMPv6-Forward"), { src: "wan", dest: "*" });
  t.is(fw.rule.find((r: any) => r.name === "Allow-DHCP-Renew").dest, undefined, "to the router: input");
});

const router = (change: (intent: any) => void) => {
  const intent = sample();
  change(intent);
  return onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
};
const iface = (config: any, name: string) =>
  config.network.interface.find((i: any) => i[".name"] === name);

test("internet: a tagged line, its queueing counting the tag", (t) => {
  const config = router((i) => (i.internet.lines[0].vlan = 10));
  t.is(iface(config, "wan").device, "eth1.10", "@wan_port.10 is the WAN port's VLAN 10");
  t.is(config.sqm.queue[0].interface, "eth1", "shaped on the port, under the tag");
  t.like(config.sqm.queue[0], { linklayer: "ethernet", overhead: "42" });
  t.like(router(() => {}).sqm.queue[0], { overhead: "38", tcMPU: 84 });
});

test("internet: the line type sets queueing's overhead", (t) => {
  const line = (type: string) =>
    router((i) => (i.internet.lines[0].shaping.medium = type)).sqm.queue[0];
  t.like(line("cable"), { linklayer: "ethernet", overhead: "18", tcMPU: 64 });
  t.like(line("vdsl"), { linklayer: "ethernet", overhead: "34" });
  t.like(line("adsl"), { linklayer: "atm", overhead: "44" });
  t.like(line("fibre"), {
    iqdisc_opts: "nat dual-dsthost ingress",
    eqdisc_opts: "nat dual-srchost",
  });
  t.like(line("vdsl"), {
    iqdisc_opts: "nat dual-dsthost ingress ptm",
    eqdisc_opts: "nat dual-srchost ptm",
  });
});

test("internet: a static address", (t) => {
  const config = router((i) => {
    Object.assign(i.internet.lines[0], {
      type: "static",
      static: { address: "203.0.113.10", prefix_length: 29, gateway: "203.0.113.9", dns: ["9.9.9.9"] },
    });
  });
  t.like(iface(config, "wan"), {
    device: "eth1",
    proto: "static",
    ipaddr: "203.0.113.10",
    netmask: "255.255.255.248",
    gateway: "203.0.113.9",
    dns: ["9.9.9.9"],
  });
  t.is(iface(config, "wan6").proto, "dhcpv6");

  const issues = (connection: any, dohOn = true) => {
    const intent = sample();
    Object.assign(intent.internet.lines[0], { type: "static", static: { prefix_length: 29, ...connection } });
    if (!dohOn) intent.dns.upstream = { type: "provider" };
    return intentSchema.safeParse(intent).error?.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`
    );
  };
  t.deepEqual(issues({ address: "203.0.113.8", gateway: "203.0.113.9" }), [
    "internet.lines.0.static.address: the subnet's own or broadcast address, not a host's",
  ]);
  t.deepEqual(issues({ address: "203.0.113.10", gateway: "203.0.113.20" }), [
    "internet.lines.0.static.gateway: not in the address's subnet",
  ]);
  t.deepEqual(issues({ address: "203.0.113.10", gateway: "203.0.113.9" }, false), [
    "internet.lines.0.static.dns: add a DNS server, or choose other DNS servers under DNS & DHCP",
  ]);
  t.deepEqual(issues({ address: "203.0.113.300", gateway: "203.0.113.9" }), [
    "internet.lines.0.static.address: an IPv4 address, like 203.0.113.10",
  ]);
});

test("internet: IPv6 asks for the prefix size; PPPoE gets an explicit wan6", (t) => {
  const config = router((i) => {
    Object.assign(i.internet.lines[0], { type: "pppoe", pppoe: { username: "u", password: "p" } });
    i.internet.lines[0].ipv6.prefix = "56";
  });
  t.like(iface(config, "wan"), { proto: "pppoe", ipv6: "1" });
  t.like(iface(config, "wan6"), { device: "@wan", proto: "dhcpv6", reqprefix: "56" });
  // Shaped on PPPoE's own device: on the port, cake cannot read the NAT inside PPPoE frames to be fair per device.
  t.like(config.sqm.queue[0], { interface: "pppoe-wan", overhead: "46" });
  t.not(router(() => {}).sqm.queue[0].interface, "pppoe-wan");
  t.false("reqprefix" in iface(router(() => {}), "wan6"), "automatic asks for nothing");

  const intent = sample();
  intent.internet.lines[0].ipv6.prefix = "64";
  intent.networks[1].ipv6 = true;
  t.deepEqual(
    intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ["internet.lines.0.ipv6.prefix: 2 networks have IPv6, and a /64 has room for 1."]
  );
});

test("packages are fixed per role; a setting off is config, not a removal", (t) => {
  const packages = (intent: any) =>
    (compile(intent).package_profiles ?? []).flatMap((p: any) => p.packages);
  const off = sample();
  delete off.internet.lines[0].shaping;
  off.dns.upstream = { type: "provider" };
  t.deepEqual(packages(off), packages(sample()));

  const config = onDevice("home-router", "friendlyarm,nanopi-r6s", off);
  t.like(config.upnpd.upnpd[0], { enabled: false });
  t.deepEqual(config.sqm.queue, [{ ".name": "wan", enabled: false, interface: "eth1" }]);
  // The proxy has no "enabled": off is no instance, and hands off dnsmasq.
  t.like(config["https-dns-proxy"].main[0], { dnsmasq_config_update: "-", force_dns: false });
  t.deepEqual(config["https-dns-proxy"]["https-dns-proxy"], []);
  t.false("server" in config.dhcp.dnsmasq[0], "dnsmasq uses the provider's resolvers");
});

test("internet: UPnP on the main network only", (t) => {
  const intent = sample();
  intent.internet.upnp = true;
  const config = onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
  const upnpd = config.upnpd.upnpd[0];
  t.like(upnpd, { enabled: true, secure_mode: true, internal_iface: "lan" });
  t.regex(upnpd.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  t.is(upnpd.uuid, onDevice("home-router", "friendlyarm,nanopi-r6s", intent).upnpd.upnpd[0].uuid);
  t.like(config.upnpd.perm_rule[0], { action: "allow", int_addr: "10.0.0.0/24" });
  t.like(config.upnpd.perm_rule[1], { action: "deny", int_addr: "0.0.0.0/0" });
  const ap = onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent).upnpd;
  t.deepEqual(ap, { upnpd: [], perm_rule: [] }, "router only: no sections on an AP");
});

test("IPv6: per network, announced only with a public prefix, and only with the internet's", (t) => {
  const on = router(() => {});
  const lan = on.network.interface.find((i: any) => i[".name"] === "lan");
  t.like(lan, { ip6assign: "64", ip6hint: "1" });
  t.like(on.dhcp.dhcp.find((d: any) => d.interface === "lan"), { ra: "server", ra_default: 1 });
  t.regex(on.network.globals[0].ula_prefix, /^fd/);

  // No IPv6 on the internet side: no network gets any, not even local-only.
  const off = router((i) => (i.internet.lines[0].ipv6.enabled = false));
  t.false("ip6assign" in off.network.interface.find((i: any) => i[".name"] === "lan"));
  t.like(off.dhcp.dhcp.find((d: any) => d.interface === "lan"), { ra: "disabled", dhcpv6: "disabled" });
  t.is(off.network.globals[0].ula_prefix, "");
  t.false(off.network.interface.some((i: any) => i[".name"] === "wan6"));

  const intent = sample();
  intent.internet.lines[0].ipv6.enabled = false;
  const ap = onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent);
  t.false(ap.network.interface.some((i: any) => i[".name"] === "lan6"), "the AP takes no IPv6 address either");
});

test("reserved addresses: a fixed lease and a DNS name, checked against the network", (t) => {
  const config = router((i) => {
    i.networks[0].dhcp.reservations = [{ name: "nas", mac: "aa:bb:cc:dd:ee:01", address: "10.0.0.20" }];
  });
  t.is(config.dhcp.host.length, 1);
  t.like(config.dhcp.host[0], { name: "nas", mac: "aa:bb:cc:dd:ee:01", ip: "10.0.0.20", dns: true });
  const issues = (reservations: any[], network = 0) => {
    const intent = sample();
    intent.networks[network].dhcp.reservations = reservations;
    return intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  const nas = { name: "nas", mac: "aa:bb:cc:dd:ee:01", address: "10.0.0.20" };
  t.deepEqual(issues([{ ...nas, address: "10.0.20.5" }]), ["networks.0.dhcp.reservations.0.address: an address in 10.0.0.x"]);
  t.deepEqual(issues([{ ...nas, address: "10.0.0.1" }]), [
    "networks.0.dhcp.reservations.0.address: 10.0.0.2 to 10.0.0.254 (.1 is the router)",
  ]);
  t.deepEqual(issues([nas, { ...nas, address: "10.0.0.21" }]), [
    "networks.0.dhcp.reservations.1.name: already used",
    "networks.0.dhcp.reservations.1.mac: already used",
  ]);
  t.deepEqual(issues([{ ...nas, name: "home-router" }]), [
    "networks.0.dhcp.reservations.0.name: already a device's name",
  ]);
  t.deepEqual(issues([{ ...nas, mac: "AA-BB" }]), ["networks.0.dhcp.reservations.0.mac: like aa:bb:cc:dd:ee:ff"]);
});

test("sharing devices: avahi reflects between sharing networks, never on WAN", (t) => {
  const conf = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    return (compile(intent).files ?? []).find((f: any) => f.path === "/etc/avahi/avahi-daemon.conf")!;
  };
  const off = conf(() => {});
  t.regex(off.content, /allow-interfaces=br-lan\.1\n/, "only the main network, for the router itself");
  t.regex(off.content, /enable-reflector=no/);
  const on = conf((i) => i.networks.forEach((n: any) => (n.share_devices = true)));
  t.regex(on.content, /allow-interfaces=br-lan\.1,br-lan\.20\n/);
  t.regex(on.content, /enable-reflector=yes/);
  t.is(on.run_after, "/etc/init.d/avahi-daemon restart");

  const fw = router((i) => i.networks.forEach((n: any) => (n.share_devices = true))).firewall;
  t.like(fw.rule.find((r: any) => r.name === "Allow-guest-mDNS"), { src: "guest", dest_port: "5353", target: "ACCEPT" });
  t.false(fw.rule.some((r: any) => r.name === "Allow-lan-mDNS"), "full router access needs none");
});

test("SSIDs: security mode, hidden, off, and fast roaming", (t) => {
  const iface = (change: (wifi: any) => void) => {
    const intent = sample();
    change(intent.wifi.networks[1]);
    return onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent).wireless["wifi-iface"].find(
      (w: any) => w.ssid === intent.wifi.networks[1].ssid
    );
  };
  t.like(iface(() => {}), { encryption: "psk2+ccmp", ieee80211r: true });
  t.is(iface((w) => (w.security = "wpa2-wpa3")).encryption, "sae-mixed");
  t.is(iface((w) => (w.security = "wpa3")).encryption, "sae");
  t.like(iface((w) => Object.assign(w, { hidden: true, enabled: false })), { hidden: true, disabled: true });
  const slow = iface((w) => (w.roaming = { ...w.roaming, fast: false }));
  t.is(slow.ieee80211r, false);
  t.true(slow.bss_transition, "802.11v stays on");
  t.is(iface(() => {}).ft_over_ds, false, "over the air, said rather than left to the default");
  t.like(iface((w) => (w.roaming = { ...w.roaming, assisted: false })), { ieee80211k: false, bss_transition: false });
  // Steering Off turns neighbour lists off on every SSID, whatever each says.
  const offEverywhere = sample();
  offEverywhere.wifi.roaming = { steering: "off", prefer_5g: false };
  t.true(
    onDevice("home-ap-1", "zyxel,nwa50ax-pro", offEverywhere).wireless["wifi-iface"].every(
      (w: any) => w.ieee80211k === false && w.bss_transition === false
    )
  );

  // usteer: passive, and only for SSIDs that give neighbour reports.
  const usteer = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    return onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent).usteer.usteer[0];
  };
  t.like(usteer(() => {}), { assoc_steering: "0", probe_steering: "0", band_steering_interval: "0" });
  t.deepEqual(usteer(() => {}).ssid_list, ["Home", "Home Guests"]);
  t.deepEqual(usteer((i) => (i.wifi.networks[1].roaming = { ...i.wifi.networks[1].roaming, assisted: false })).ssid_list, ["Home"]);
  t.deepEqual(usteer((i) => (i.wifi.networks[0].enabled = false)).ssid_list, ["Home Guests"]);
  // An empty ssid_list would mean every SSID: with none taking part, usteer stops.
  t.like(
    usteer((i) => i.wifi.networks.forEach((w: any) => (w.roaming = { ...w.roaming, assisted: false }))),
    { enabled: false }
  );

  // Wi-Fi › Roaming: off stops usteer and neighbour lists; advise moves
  // nothing; nudge asks; push asks, then disconnects. aggressiveness is
  // always set: its default (3) would kick.
  const roaming = (steering: string, prefer_5g = false) =>
    usteer((i) => (i.wifi.roaming = { steering, prefer_5g }));
  t.like(roaming("off"), { enabled: false });
  t.like(roaming("advise"), {
    enabled: true,
    aggressiveness: "1",
    roam_scan_snr: "0",
    roam_trigger_snr: "0",
    min_snr: "0",
    band_steering_interval: "0",
  });
  t.like(roaming("nudge"), {
    aggressiveness: "1",
    roam_scan_snr: "-70",
    roam_trigger_snr: "-75",
    roam_kick_delay: "10000",
    min_snr: "0",
  });
  t.like(roaming("push"), { aggressiveness: "3", roam_trigger_snr: "-75", min_snr: "-82" });
  t.like(roaming("advise", true), {
    aggressiveness: "1",
    roam_trigger_snr: "0",
    roam_kick_delay: "10000",
    band_steering_interval: "30000",
    band_steering_min_snr: "-60",
  });

  const intent = sample();
  intent.wifi.networks[0].security = "wpa3";
  t.deepEqual(
    intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ["wifi.networks.0.extra_passwords: Only with WPA2: WPA3 has one password per network."]
  );
});

test("DNS: where names are looked up, rebind protection, own names, DHCP's DNS", (t) => {
  const dns = (change: (intent: any) => void) => {
    const config = router(change);
    return { dnsmasq: config.dhcp.dnsmasq[0], wan: iface(config, "wan"), config };
  };
  const encrypted = dns(() => {});
  t.like(encrypted.dnsmasq, { noresolv: true, server: ["127.0.0.1#5053"], rebind_protection: true, rebind_localhost: true });
  t.is(encrypted.wan.peerdns, false);

  const provider = dns((i) => (i.dns.upstream = { type: "provider" }));
  t.false("server" in provider.dnsmasq);
  t.is(provider.wan.peerdns, true, "the provider's resolvers");

  const custom = dns((i) => (i.dns.upstream = { type: "custom", servers: ["9.9.9.9", "2620:fe::fe"] }));
  t.like(custom.dnsmasq, { noresolv: true, server: ["9.9.9.9", "2620:fe::fe"] });
  t.is(custom.wan.peerdns, false);

  // Off is written off: dnsmasq turns it on when unset.
  t.is(dns((i) => (i.dns.rebind_protection = false)).dnsmasq.rebind_protection, false);

  const named = dns((i) => (i.dns.hosts = [{ name: "printer", address: "10.0.0.30" }])).config;
  t.like(named.dhcp.domain[0], { name: "printer", ip: "10.0.0.30" });

  // A Pi-hole on the home network: guests must be able to reach it.
  const piHole = dns((i) => {
    i.networks[1].dhcp.dns_servers = ["10.0.0.53"];
    i.networks[1].access.networks = ["lan"];
  }).config;
  t.deepEqual(piHole.dhcp.dhcp.find((d: any) => d.interface === "guest").dhcp_option, ["42,10.0.20.1", "6,10.0.0.53"]);

  const issues = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    return intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  t.deepEqual(issues((i) => (i.dns.hosts = [{ name: "a", address: "x" }, { name: "a", address: "10.0.0.2" }])), [
    "dns.hosts.0.address: an IP address, like 10.0.0.20",
    "dns.hosts.1.name: already used",
  ]);
  t.deepEqual(issues((i) => (i.dns.upstream = { type: "custom", servers: [] })), [
    "dns.upstream.servers: at least one server",
  ]);
});

test("patches apply only where they say: by model, by role", (t) => {
  const files = (hostname: string, model: string, change: (i: any) => void = () => {}) => {
    const intent = sample();
    change(intent);
    const oncConfig = compile(intent);
    const deviceSchema = deviceSchemaSchema.parse(
      JSON.parse(readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8"))
    );
    const deviceConfig = oncConfig.devices.find((d) => d.hostname === hostname)!;
    return (getOpenWrtState({ oncConfig, deviceConfig, deviceSchema }).files ?? []).map((f: any) => f.path);
  };
  t.deepEqual(files("home-router", "friendlyarm,nanopi-r6s").filter((p: string) => !p.includes("avahi")), [
    "/usr/libexec/platform/packet-steering.sh",
    "/etc/hotplug.d/iface/30-odhcpd-ra-fix",
    "/usr/libexec/onc/ubihealthd-config",
    "/usr/libexec/onc/leases-to-ram",
  ]);
  t.deepEqual(files("home-ap-1", "zyxel,nwa50ax-pro"), [
    "/etc/hotplug.d/net/20-aql",
    "/usr/libexec/onc/ubihealthd-config",
  ]);
  t.deepEqual(
    files("home-router", "friendlyarm,nanopi-r6s", (i) => (i.internet.lines[0].ipv6.enabled = false)).filter(
      (p: string) => !p.includes("avahi")
    ),
    ["/usr/libexec/platform/packet-steering.sh", "/usr/libexec/onc/ubihealthd-config", "/usr/libexec/onc/leases-to-ram"],
    "the odhcpd fix only where the internet's IPv6 is on"
  );
});

test("airtime: each band's queue limits, on the access points", (t) => {
  const aql = (radios: object) => {
    const intent = sample();
    intent.wifi.radios = { ...(intent.wifi.radios ?? {}), ...radios };
    return (compile(intent).files ?? []).find((f: any) => f.path.endsWith("20-aql"))!.content;
  };
  t.regex(aql({}), /in "2G 5000 12000" "5G 5000 12000"; do/, "balanced on each band by default");
  t.regex(
    aql({ "2g": { airtime: "throughput" }, "5g": { airtime: "latency" } }),
    /limits="2000 4000"\n  for entry in "5G 2000 4000" "2G 8000 20000"; do/,
    "per band, tightest first and as the fallback"
  );
  t.regex(aql({ "2g": { enabled: false } }), /in "5G 5000 12000"; do/, "only bands that are on");
});

test("on the access point: bridged, a DHCP client, Wi-Fi on both bands", (t) => {
  const config = onDevice("home-ap-1", "zyxel,nwa50ax-pro");
  const iface = (name: string) =>
    config.network.interface.find((i: any) => i[".name"] === name);
  t.is(iface("lan").proto, "dhcp", "a client of the main network");
  t.like(iface("guest"), { device: "br-lan.20", proto: "none" }, "guests only bridged");
  t.deepEqual(
    config.wireless["wifi-device"].map((r: any) => [r.band, r.channel]),
    [
      ["2g", 11],
      ["5g", 36],
    ]
  );
  t.deepEqual(
    config.wireless["wifi-iface"].map((w: any) => [w.ssid, w.network, w.isolate]),
    [
      ["Home", "lan", undefined],
      ["Home", "lan", undefined],
      ["Home Guests", "guest", true],
      ["Home Guests", "guest", true],
    ],
    "each Wi-Fi on both bands, on its network; guests isolated"
  );
  t.true(
    Object.values(config.firewall ?? {}).every((s: any) => s.length === 0),
    "no firewall sections"
  );
  t.false("ubihealthd" in config, "the device's own ubihealthd config is kept, not written");
  const keeps = compile().configs_to_not_reset!.flatMap((k: any) => k.configs);
  t.true(keeps.includes("?ubihealthd.*"));
});

test("radios are set per band; an SSID can keep to some bands; 6 GHz is WPA3", (t) => {
  const intent = sample();
  intent.wifi.radios = {
    "2g": { enabled: true, width: "auto", power: "low", cell_density: "off" },
    "5g": { enabled: true, width: "160", power: "auto", cell_density: "high" },
    "6g": { enabled: true },
  };
  intent.wifi.networks[1].bands = ["2g"];
  const config = compile(intent).config.wireless as any;
  const radio = (band: string) => config["wifi-device"].find((d: any) => d.band === band);
  // The best mode at the width: which one, the engine decides per radio.
  t.like(radio("2g"), { htmode: "@best/20", txpower: 10, cell_density: 0 });
  t.like(radio("5g"), { htmode: "@best/160", cell_density: 2 });
  t.is(radio("5g").txpower, undefined, "auto: as much as the country allows");
  t.is(radio("6g").disabled, undefined);
  t.deepEqual(
    config["wifi-iface"].map((w: any) => [w.ssid, w.device, w.encryption]),
    [
      ["Home", ["radio0", "radio1"], "psk2+ccmp"],
      ["Home", ["radio2"], "sae"],
      ["Home Guests", ["radio0"], "psk2+ccmp"],
    ]
  );
});

test("the intent is checked before it compiles", (t) => {
  const bad = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    return () => intentSchema.parse(intent);
  };
  t.throws(
    bad((i) => i.hardware.push({ name: "second", role: "router" })),
    { message: /exactly one device must be the router/ }
  );
  t.throws(bad((i) => (i.system.timezone = "Mars/Olympus")), {
    message: /IANA zone/,
  });
  t.throws(bad((i) => (i.wifi.networks[0].password = "short")), {
    message: /at least 8/,
  });
  t.throws(bad((i) => (i.hardware[0].model_id = "x")), {
    message: /Unrecognized key/,
  });
});

test("rules across settings are checked, at the field they concern", (t) => {
  const issues = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    const result = intentSchema.safeParse(intent);
    return result.success
      ? []
      : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  t.deepEqual(issues(() => {}), []);
  t.deepEqual(issues((i) => (i.networks[1].vlan = undefined)), [
    "networks: exactly one network must be the main, untagged one",
  ]);
  t.deepEqual(issues((i) => (i.networks[1].subnet = "10.0.0.0/24")), [
    "networks.1.subnet: already used by another network",
  ]);
  t.deepEqual(issues((i) => (i.wifi.networks[1].network = "gone")), [
    "wifi.networks.1.network: pick a network",
  ]);
  t.deepEqual(issues((i) => (i.networks[1].vlan = 1)), [
    "networks.1.vlan: 2 to 4094 (1 is the main network)",
  ]);
  t.deepEqual(issues((i) => (i.networks[0].access.networks = ["lan", "gone"])), [
    "networks.0.access.networks: a network always reaches itself",
    'networks.0.access.networks: no network "gone"',
  ]);
  t.deepEqual(issues((i) => (i.networks[1].id = "router")), [
    "networks.1.id: reserved",
    "wifi.networks.1.network: pick a network",
    'networks.0.access.networks: no network "guest"',
    "firewall.rules.0.from: pick a network, the internet or anywhere",
  ]);
  t.deepEqual(issues((i) => (i.networks[0].access.router = "services")), [
    "networks.0.access.router: The main network manages the router and access points: it keeps full access.",
  ]);
  // Ports are kept for when the protocol is TCP or UDP again, and left out meanwhile.
  t.deepEqual(issues((i) => (i.firewall.rules[0].protocol = "icmp")), []);
  const icmp = sample();
  icmp.firewall.rules[0].protocol = "icmp";
  const compiledRule = (compile(icmp).config as any).firewall.rule.find(
    (r: any) => r.name === icmp.firewall.rules[0].name
  );
  t.is(compiledRule?.dest_port, undefined);
  t.deepEqual(issues((i) => i.firewall.rules[0].to_addresses.push("fd00::1")), [
    "firewall.rules.0.to_addresses: IPv4 and IPv6 addresses cannot share a rule",
  ]);
  t.deepEqual(
    issues((i) => (i.firewall.port_forwards[0].to.address = "192.168.9.9")),
    ["firewall.port_forwards.0.to.address: not on any of your networks"]
  );
  t.deepEqual(
    issues((i) =>
      i.firewall.port_forwards.push({ ...i.firewall.port_forwards[0], name: "Again", protocol: "tcp+udp" })
    ),
    ["firewall.port_forwards.1.port: already forwarded"]
  );
});

test("a file newer than the tool is refused", (t) => {
  t.throws(() => migrateIntent({ ...sample(), schema: 99 }), { message: /newer/ });
  t.is(intentSchema.parse(migrateIntent(sample())).schema, 1);
});

test("the ULA prefix is stable and well-formed", (t) => {
  t.is(ulaPrefix("Home"), ulaPrefix("Home"));
  t.not(ulaPrefix("Home"), ulaPrefix("Cabin"));
  t.regex(ulaPrefix("Home"), /^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48$/);
});

test("zones and forwardings are named for what they are, so another network never renames them", (t) => {
  const names = (intent: any) => {
    const { firewall } = onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
    return [...firewall.zone, ...firewall.forwarding].map((s: any) => s[".name"]);
  };
  const before = names(sample());
  t.deepEqual(before, ["lan", "guest", "wan", "lan_wan", "lan_guest", "guest_wan"]);
  const reordered = sample();
  reordered.networks.reverse();
  t.deepEqual([...names(reordered)].sort(), [...before].sort());
});

test("services: each role's kept enabled and started; those that must run are checked", (t) => {
  const services = (hostname: string, model: string, change: (i: any) => void = () => {}) => {
    const intent = sample();
    change(intent);
    const oncConfig = compile(intent);
    const deviceSchema = deviceSchemaSchema.parse(
      JSON.parse(readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8"))
    );
    const deviceConfig = oncConfig.devices.find((d) => d.hostname === hostname)!;
    return getOpenWrtState({ oncConfig, deviceConfig, deviceSchema }).services ?? [];
  };
  const router = services("home-router", "friendlyarm,nanopi-r6s");
  const running = (list: { name: string; running: boolean }[]) => list.filter((s) => s.running).map((s) => s.name).sort();
  t.true(["sqm", "firewall", "ubihealthd"].every((n) => router.some((s) => s.name === n && !s.running)));
  t.true(["dnsmasq", "odhcpd", "dropbear", "avahi-daemon"].every((n) => running(router).includes(n)));
  t.false(router.some((s) => ["wpad", "usteer"].includes(s.name)), "no Wi-Fi on the router");
  const ap = services("home-ap-1", "zyxel,nwa50ax-pro");
  t.true(["wpad", "dropbear", "network"].every((n) => running(ap).includes(n)));
  t.false(ap.some((s) => ["dnsmasq", "odhcpd", "sqm"].includes(s.name)), "an access point routes nothing");
  t.false(
    running(services("home-router", "friendlyarm,nanopi-r6s", (i) => (i.internet.upnp = false))).includes("miniupnpd"),
    "UPnP off: enabled, but nothing should run"
  );
});

test("two internet connections: a line on a LAN port, mwan3 over both, queueing on each", (t) => {
  const twoLines = (mode: "failover" | "balance") => {
    const intent = sample();
    intent.internet.use_lines = { ...intent.internet.use_lines, mode: mode };
    intent.internet.lines.push({
      id: "wanb",
      name: "LTE",
      port: "eth2",
      type: "dhcp",
      ipv6: { enabled: true },
      shaping: { down_mbps: 50, up_mbps: 10 },
      failover: { weight: 3 },
    });
    return intent;
  };
  const config = onDevice("home-router", "friendlyarm,nanopi-r6s", twoLines("failover"));
  const iface = (name: string) => config.network.interface.find((i: any) => i[".name"] === name);
  t.like(iface("wan"), { device: "eth1", metric: 10 });
  t.like(iface("wanb"), { device: "eth2", metric: 20 });
  t.is(iface("wanb6"), undefined, "IPv6 from the first connection only");
  t.false(config.network.device[0].ports.includes("eth2"), "its port leaves the LAN bridge");
  t.deepEqual(
    config.sqm.queue.map((q: any) => [q[".name"], q.interface, q.download]),
    [
      ["wan", "eth1", "950000"],
      ["wanb", "eth2", "50000"],
    ]
  );
  t.deepEqual(config.firewall.zone.find((z: any) => z.name === "wan").network, ["wan", "wan6", "wanb"]);
  t.deepEqual(config.mwan3.member.map((m: any) => [m.interface, m.metric]), [["wan", 1], ["wanb", 2]]);
  t.deepEqual(config.mwan3.policy[0].use_member, ["wan_m1", "wanb_m2"]);
  t.deepEqual(config.mwan3.rule.map((r: any) => r[".name"]), ["default"]);

  // A network kept to the backup line has no IPv6, which only the main line carries.
  const pinned = twoLines("failover");
  pinned.networks[0].access = { ...pinned.networks[0].access, via: "wanb", fallback: true };
  const pinnedConfig = onDevice("home-router", "friendlyarm,nanopi-r6s", pinned);
  t.is(pinnedConfig.network.interface.find((i: any) => i[".name"] === "lan").ip6assign, undefined);
  t.truthy(availability(intentSchema.parse(pinned), "networks.0.ipv6").option(true).unavailable);

  // A metered line, even listed first, is failover's last resort (without
  // IPv6: that goes out the first line alone, so it is refused with it).
  const meteredFirst = twoLines("failover");
  meteredFirst.internet.lines[0].failover = { ...meteredFirst.internet.lines[0].failover, metered: true };
  t.false(intentSchema.safeParse(meteredFirst).success);
  meteredFirst.internet.lines[0].ipv6 = { ...meteredFirst.internet.lines[0].ipv6, enabled: false };
  const last = onDevice("home-router", "friendlyarm,nanopi-r6s", meteredFirst);
  t.deepEqual(last.mwan3.policy[0].use_member, ["wan_m2", "wanb_m1"]);

  const shared = onDevice("home-router", "friendlyarm,nanopi-r6s", twoLines("balance"));
  t.deepEqual(shared.mwan3.member.map((m: any) => [m.metric, m.weight]), [[1, 1], [1, 3]]);
  t.deepEqual(shared.mwan3.rule.map((r: any) => r[".name"]), ["https", "default"], "secure sites keep to one line");

  const packages = compile(twoLines("failover")).package_profiles!.flatMap((p: any) => p.packages);
  t.true(packages.includes("mwan3"));
  t.true(compile().package_profiles!.flatMap((p: any) => p.packages).includes("mwan3"), "one line: installed all the same");
  const oneLine = getOpenWrtState({
    oncConfig: compile(),
    deviceConfig: compile().devices.find((d) => d.hostname === "home-router")!,
    deviceSchema: deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "friendlyarm,nanopi-r6s.json"), "utf8"))),
  });
  t.like(oneLine.services!.find((s) => s.name === "mwan3"), { enabled: false }, "...and off: stopped and disabled");
  t.deepEqual(
    onDevice("home-router", "friendlyarm,nanopi-r6s").mwan3,
    { globals: [{ ".name": "globals", mmx_mask: "0x3F00" }], interface: [], member: [], policy: [], rule: [] },
    "one line: declared all the same, so the package's first start reads nothing to track"
  );
});

test("connections: one per port, the WAN port once, ids of their own", (t) => {
  const issues = (change: (i: any) => void) => {
    const intent = sample();
    change(intent);
    const result = intentSchema.safeParse(intent);
    return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  const second = { id: "wanb", name: "LTE", type: "dhcp" };
  t.deepEqual(issues((i) => i.internet.lines.push(second)), [
    "internet.lines.1.port: Fibre uses the WAN port.",
  ]);
  t.deepEqual(
    issues((i) => {
      i.internet.lines[0].port = "eth2";
      i.internet.lines.push({ ...second, port: "eth2" });
    }),
    ["internet.lines.1.port: Fibre uses it."]
  );
  t.true(issues((i) => (i.networks[1].id = "wanx")).some((m) => m.endsWith("reserved")));
  // Names a section of the compiler's or the engine's has: they would merge.
  for (const id of ["mesh0", "dnsmasq0", "device1", "defaults0"]) {
    t.true(issues((i) => (i.networks[1].id = id)).some((m) => m.endsWith("reserved")), id);
  }
  t.false(issues((i) => (i.networks[1].id = "net2")).some((m) => m.endsWith("reserved")), "the UI's ids stay free");
});

test("several lines: a network keeps to one, a metered line is a last resort, a slow line counts as down, devices keep to a line", (t) => {
  const intent = sample();
  intent.internet.use_lines = { ...intent.internet.use_lines, mode: "balance" };
  intent.internet.use_lines = { ...intent.internet.use_lines, sticky_per_device: true };
  intent.internet.lines.push({
    id: "wanb",
    name: "LTE",
    port: "eth2",
    type: "dhcp",
    ipv6: { enabled: false, prefix: "auto" },
    failover: { weight: 1, metered: true, down_when_slow: true },
  });
  intent.networks[1].access = { ...intent.networks[1].access, via: "wanb", fallback: false };
  const { mwan3 } = onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
  const policy = (name: string) => mwan3.policy.find((p: any) => p[".name"] === name).use_member;
  const memberOf = (name: string) => mwan3.member.find((m: any) => m[".name"] === name);
  t.deepEqual(policy("internet").map((m: string) => memberOf(m).metric), [1, 2], "the metered line only when the other is down");
  t.deepEqual(policy("via_guest"), ["wanb_m1"], "guests: only the LTE");
  t.like(mwan3.rule[0], { ".name": "net_guest", src_ip: intent.networks[1].subnet, use_policy: "via_guest" });
  t.like(mwan3.rule.at(-1), { ".name": "default", sticky: true, timeout: 600 });
  t.false(mwan3.rule.some((r: any) => r[".name"] === "https"), "per device covers secure sites too");
  const lte = mwan3.interface.find((i: any) => i[".name"] === "wanb");
  t.like(lte, { interval: 30, track_ip: ["1.1.1.1"], check_quality: true, failure_latency: 500, count: 5 });
  t.is(mwan3.interface.find((i: any) => i[".name"] === "wan").check_quality, undefined);

  intent.networks[1].access = { ...intent.networks[1].access, via: "wanb", fallback: true };
  const fallback = onDevice("home-router", "friendlyarm,nanopi-r6s", intent).mwan3;
  t.deepEqual(fallback.policy.find((p: any) => p[".name"] === "via_guest").use_member, ["wanb_m1", "wan_m2"]);

  // Kept to the main line: its fallback takes the unmetered line before the metered one.
  intent.internet.lines.push({ ...intent.internet.lines[0], id: "wanc", name: "Cable", port: "eth0", failover: { weight: 1, metered: false, down_when_slow: false } });
  intent.networks[1].access = { ...intent.networks[1].access, via: "wan", fallback: true };
  const kept = onDevice("home-router", "friendlyarm,nanopi-r6s", intent).mwan3;
  t.deepEqual(kept.policy.find((p: any) => p[".name"] === "via_guest").use_member, ["wan_m1", "wanc_m2", "wanb_m3"]);

  intent.networks[1].access = { ...intent.networks[1].access, via: "wanz", fallback: true };
  t.true(
    (intentSchema.safeParse(intent) as any).error.issues.some((i: any) => i.path.join(".") === "networks.1.access.via")
  );
});

test("mesh: access points (and a router with a radio) link over 802.11s with batman-adv, the bridge carrying every network over it", (t) => {
  const meshed = () => {
    const intent = sample();
    intent.wifi.mesh = { enabled: true, band: "5g", channel: 44, key: "mesh-key-123456", band_reserved: false, over_cable: false, large_frames: true };
    intent.hardware.push({ name: "home-ap-2", role: "access-point", uplink: "mesh" });
    return intent;
  };
  const ap = onDevice("home-ap-1", "zyxel,nwa50ax-pro", meshed());
  const iface = (name: string) => ap.network.interface.find((i: any) => i[".name"] === name);
  t.like(iface("bat0"), { proto: "batadv", routing_algo: "BATMAN_V", bridge_loop_avoidance: true, hop_penalty: 30, gw_mode: "off" });
  t.like(iface("batmesh"), { proto: "batadv_hardif", master: "bat0" });
  t.like(ap.network.device.find((d: any) => d.name === "mesh0"), { mtu: 1532 });
  t.true(ap.network.device.find((d: any) => d.name === "br-lan").ports.includes("bat0"));
  t.true(ap.network["bridge-vlan"].find((v: any) => v.vlan === 20).ports.includes("bat0:t"), "other networks tagged over it");
  const meshIface = ap.wireless["wifi-iface"].find((w: any) => w.mode === "mesh");
  t.like(meshIface, { ifname: "mesh0", encryption: "sae", mesh_fwding: false, network: "batmesh", key: "mesh-key-123456" });
  t.is(meshIface.device, "radio1");
  t.is(ap.wireless["wifi-device"].find((d: any) => d.band === "5g").channel, 44, "the mesh's channel");

  const router = onDevice("home-router", "friendlyarm,nanopi-r6s", meshed());
  t.is(router.network.interface.find((i: any) => i[".name"] === "bat0"), undefined, "no radio: not a node");
  t.false(router.network.device[0].ports.includes("bat0"));
  // A router with Wi-Fi: the R6S's ports, the access point's radios.
  const radioRouter = (() => {
    const oncConfig = compile(meshed());
    const read = (model: string) => JSON.parse(readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8"));
    const deviceSchema = deviceSchemaSchema.parse({ ...read("friendlyarm,nanopi-r6s"), radios: read("zyxel,nwa50ax-pro").radios });
    const deviceConfig = oncConfig.devices.find((d) => d.hostname === "home-router")!;
    return getOpenWrtConfig({ oncConfig, deviceConfig, deviceSchema }) as any;
  })();
  t.truthy(radioRouter.network.interface.find((i: any) => i[".name"] === "bat0"), "a router with a radio is a node");
  t.like(radioRouter.wireless["wifi-device"].find((d: any) => d.band === "5g"), { channel: 44 });

  const devices = compile(meshed()).devices;
  t.is(devices.find((d: any) => d.hostname === "home-ap-2")!.provision_order, -1, "the repeater first");
  t.is(devices.find((d: any) => d.hostname === "home-ap-1")!.provision_order, undefined);
  t.is(onDevice("home-ap-1", "zyxel,nwa50ax-pro").network.interface.find((i: any) => i[".name"] === "bat0"), undefined, "off: nothing");
});

test("mesh: turning it on makes its key; a channel a radar could move is refused", (t) => {
  const intent = intentSchema.parse(sample());
  const on = availability(intent, "wifi.mesh.enabled").option(true).swap!.apply(intent);
  t.true(on.wifi.mesh.enabled);
  t.regex(on.wifi.mesh.key!, /^[A-Za-z0-9]{32}$/);
  t.not(availability(intent, "wifi.mesh.enabled").option(true).swap!.apply(intent).wifi.mesh.key, on.wifi.mesh.key);
  const issues = intentSchema.safeParse({ ...on, wifi: { ...on.wifi, mesh: { ...on.wifi.mesh, channel: 52 } } });
  t.true(!issues.success && issues.error.issues.some((i) => i.path.join(".") === "wifi.mesh.channel"));
});

test("mesh: its band is at most 80 MHz wide, as 160 reaches radar channels", (t) => {
  const intent = sample();
  intent.wifi.radios = { ...(intent.wifi.radios ?? {}), "5g": { enabled: true, width: "160" } };
  const width = (mesh: boolean) => {
    intent.wifi.mesh = { enabled: mesh, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: false, over_cable: false, large_frames: true };
    return (compile(intent).config.wireless as any)["wifi-device"].find((d: any) => d.band === "5g").htmode;
  };
  t.is(width(false), "@best/160");
  t.is(width(true), "@best/80");
});

test("mesh: a band kept for it carries no SSID", (t) => {
  const intent = sample();
  intent.wifi.radios = { ...(intent.wifi.radios ?? {}), "6g": { enabled: true } };
  intent.wifi.mesh = { enabled: true, band: "6g", channel: 37, key: "mesh-key-123456", band_reserved: true, over_cable: false, large_frames: true };
  const ifaces = (compile(intent).config.wireless as any)["wifi-iface"];
  t.false(ifaces.some((w: any) => w.mode === "ap" && w.device.includes("radio2")), "no SSID on 6 GHz");
  t.true(ifaces.some((w: any) => w.mode === "mesh" && w.device.includes("radio2")));
});

test("mesh over cables: a VLAN of its own on every device's physical ports, batman on it on the nodes", (t) => {
  const intent = sample();
  intent.wifi.mesh = { enabled: true, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: false, over_cable: true, large_frames: true };
  const ap = onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent);
  t.deepEqual(ap.network["bridge-vlan"].find((v: any) => v.vlan === 4000).ports, ["eth0:t"], "the cable, not bat0");
  t.like(ap.network.interface.find((i: any) => i[".name"] === "batwired"), { proto: "batadv_hardif", master: "bat0", device: "br-lan.4000" });
  const router = onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
  t.deepEqual(router.network["bridge-vlan"].find((v: any) => v.vlan === 4000).ports, ["eth0:t", "eth2:t"], "passed on");
  t.is(router.network.interface.find((i: any) => i[".name"] === "batwired"), undefined);
  intent.networks[1].vlan = 4000;
  const result = intentSchema.safeParse(intent);
  t.true(!result.success && result.error.issues.some((i) => i.path.join(".") === "networks.1.vlan"));
});

test("mesh rescue: a repeater gets a rescue Wi-Fi (off), its own link-local address, and the watcher", (t) => {
  const intent = sample();
  intent.wifi.mesh = { enabled: true, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: false, over_cable: false, large_frames: true };
  intent.hardware[1].uplink = "mesh";
  const ap = onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent);
  const rescue = ap.wireless["wifi-iface"].find((w: any) => w.ifname === "rescue0");
  t.like(rescue, { ssid: "home-ap-1 rescue", disabled: true, network: "rescue", key: "mesh-key-123456", device: "radio0" });
  t.is(rescue.encryption, "sae", "WPA3, as the mesh: its key never offered to a WPA2 handshake");
  t.regex(ap.network.interface.find((i: any) => i[".name"] === "rescue").ipaddr, /^169\.254\.\d+\.\d+$/);
  const state = getOpenWrtState({
    oncConfig: compile(intent),
    deviceConfig: compile(intent).devices.find((d) => d.hostname === "home-ap-1")!,
    deviceSchema: deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "zyxel,nwa50ax-pro.json"), "utf8"))),
  });
  t.true(state.files!.some((f) => f.path === "/etc/init.d/onc-mesh-rescue"));
  t.true(state.services!.some((s) => s.name === "onc-mesh-rescue" && s.running));
  intent.hardware[1].uplink = "cable";
  t.is(onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent).wireless["wifi-iface"].find((w: any) => w.ifname === "rescue0"), undefined, "cabled: none");
});

test("remote access, sites and a provider's tunnel: WireGuard on the router, zones from access, a network out through the tunnel", async (t) => {
  const { newPrivateKey, publicKeyOf } = await import("../../wireguard");
  const intent = sample();
  intent.vpn = {
    remote_access: {
      enabled: true,
      port: 51820,
      subnet: "10.0.99.0/24",
      private_key: newPrivateKey(),
      access: { internet: true, networks: ["lan"], router: "full" },
      clients: [{ id: "c1", name: "Phone", public_key: publicKeyOf(newPrivateKey()), host: 2, route: "home" }],
    },
  };
  intent.vpn.sites = {
    private_key: newPrivateKey(),
    port: 51821,
    access: { internet: false, networks: ["lan"], router: "services" },
    peers: [{ id: "s1", name: "Cabin", public_key: publicKeyOf(newPrivateKey()), endpoint: "cabin.example.com:51821", subnets: ["192.168.50.0/24"] }],
  };
  intent.vpn.providers = [
    {
      id: "tun1",
      name: "Mullvad",
      private_key: newPrivateKey(),
      address: "10.64.12.34/32",
      dns: ["10.64.0.1"],
      peer: { public_key: publicKeyOf(newPrivateKey()), endpoint: "203.0.113.5:51820" },
    },
  ];
  intent.networks[1].access = { ...intent.networks[1].access, via: "tun1", fallback: false };
  const r = onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
  const iface = (name: string) => r.network.interface.find((i: any) => i[".name"] === name);
  t.like(iface("vpn"), { proto: "wireguard", listen_port: 51820 });
  t.deepEqual(iface("vpn").addresses[0], "10.0.99.1/24");
  t.like(r.network.wireguard_vpn[0], { route_allowed_ips: false });
  t.deepEqual(r.network.wireguard_vpn[0].allowed_ips[0], "10.0.99.2/32");
  t.like(r.network.wireguard_sites[0], { endpoint_host: "cabin.example.com", endpoint_port: 51821, route_allowed_ips: true });
  t.like(iface("tun1"), { proto: "wireguard", ip4table: 101 });
  t.like(r.network.wireguard_tun1[0], { endpoint_host: "203.0.113.5", route_allowed_ips: true });
  t.deepEqual(
    r.network.rule.map((x: any) => [x[".name"], x.lookup ?? x.action]),
    [
      ["local_lan", "main"],
      ["local_guest", "main"],
      ["local_vpn", "main"],
      ["local_s1_0", "main"],
      ["via_guest", 101],
      ["only_guest", "unreachable"],
    ]
  );
  const zone = (name: string) => r.firewall.zone.find((z: any) => z.name === name);
  t.like(zone("vpn"), { input: "ACCEPT", network: ["vpn"] });
  t.like(zone("tun1"), { masq: true });
  t.truthy(r.firewall.forwarding.find((f: any) => f.src === "guest" && f.dest === "tun1"));
  t.truthy(r.firewall.forwarding.find((f: any) => f.src === "vpn" && f.dest === "lan"));
  t.truthy(r.firewall.rule.find((x: any) => x.name === "Allow-WireGuard" && x.dest_port === "51820"));
  const guestDhcp = r.dhcp.dhcp.find((d: any) => d[".name"] === "guest");
  t.true(guestDhcp.dhcp_option.includes("6,10.64.0.1"), "the provider's DNS, through the tunnel");
  t.is(r.network.rule.find((x: any) => x[".name"] === "local_lan").dest, "10.0.0.0/24", "local ranges by name, not suppress_prefixlength");
  t.is(iface("guest").ip6assign, undefined, "no IPv6 around the tunnel");

  intent.vpn.sites.peers[0].subnets = ["10.0.0.0/16"];
  const clash = intentSchema.safeParse(intent);
  t.true(!clash.success && clash.error.issues.some((i) => i.message.includes("overlaps")));

  // Without internet access, the tunnel is no way out either.
  intent.vpn.sites.peers[0].subnets = ["192.168.50.0/24"];
  // Never a fallback to the plain line; with no DNS from the provider, public ones through the tunnel.
  t.truthy(availability(intent, "networks.1.access.fallback").option(true).unavailable);
  delete intent.vpn.providers[0].dns;
  const noDns = onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
  t.true(noDns.dhcp.dhcp.find((d: any) => d[".name"] === "guest").dhcp_option.includes("6,9.9.9.9,1.1.1.1"));
  intent.networks[1].access.internet = false;
  const off = onDevice("home-router", "friendlyarm,nanopi-r6s", intent);
  t.falsy(off.firewall.forwarding.find((f: any) => f.src === "guest" && f.dest === "tun1"));
  t.deepEqual(off.network.rule ?? [], []);
  t.truthy(availability(intent, "networks.1.access.via").unavailable);
});

test("mesh rescue watcher: on once after the quiet, off once when the mesh is back, gone when its network is", (t) => {
  const intent = sample();
  intent.wifi.mesh = { enabled: true, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: false, over_cable: false, large_frames: true };
  intent.hardware[1].uplink = "mesh";
  const state = getOpenWrtState({
    oncConfig: compile(intent),
    deviceConfig: compile(intent).devices.find((d) => d.hostname === "home-ap-1")!,
    deviceSchema: deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "zyxel,nwa50ax-pro.json"), "utf8"))),
  });
  const script = state.files!.find((f) => f.path === "/usr/libexec/onc/mesh-rescue")!.content;
  const quiet = rescueAfterMinutes * 2;
  // Each pass (one sleep): quiet, then the mesh back, then the network gone.
  const dir = tempDir("rescue");
  const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("sleep", `n=$(cat ${dir}/n 2>/dev/null || echo 0); echo $((n + 1)) > ${dir}/n; [ $n -lt ${quiet + 6} ]`);
  stub("batctl", `[ $(cat ${dir}/n) -gt ${quiet + 2} ] && echo node`);
  stub("uci", `case "$*" in *"show wireless"*) [ $(cat ${dir}/n) -le ${quiet + 4} ] && echo "wireless.rescue_radio0.ifname='rescue0'" ;; *"get wireless.rescue_radio0.device"*) echo radio0 ;; *) echo "uci $*" >> ${dir}/log ;; esac`);
  stub("wifi", `echo "wifi $*" >> ${dir}/log`);
  stub("logger", "true");
  const run = spawnSync("sh", ["-c", script], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" });
  t.is(run.status, 0, run.stderr);
  t.deepEqual(readFileSync(join(dir, "log"), "utf8").trim().split("\n"), [
    "uci set wireless.rescue_radio0.disabled=0",
    "uci set wireless.radio0.disabled=0",
    "wifi up",
    "uci -q revert wireless.rescue_radio0",
    "uci -q revert wireless.radio0",
    "wifi up",
  ]);
  t.is(readFileSync(join(dir, "n"), "utf8").trim(), String(quiet + 5), "it left once its network was gone");
});

test("an internet line on a swconfig router: a switch VLAN of its own, out of the networks'", (t) => {
  const vlans = (intent: Intent) => {
    const r = onDevice("home-router", "tplink,archer-c50-v4", intent);
    return {
      switch: r.network.switch_vlan.map((v: any) => `${v.vlan}: ${v.ports}`),
      wan: r.network.interface.find((i: any) => i[".name"] === "wan").device,
    };
  };
  const intent = sample();
  // The WAN port: OpenWrt's own layout (VLAN 2, the CPU tagged).
  t.deepEqual(vlans(intent), { switch: ["1: 6t 1 2 3 4", "20: 6t 1t 2t 3t 4t", "2: 6t 0"], wan: "eth0.2" });
  intent.internet.lines[0].port = "port2";
  t.deepEqual(vlans(intent), { switch: ["1: 6t 0 1 3 4", "20: 6t 0t 1t 3t 4t", "2: 6t 2"], wan: "eth0.2" });
  delete intent.internet.lines[0].port;
  intent.internet.lines[0].vlan = 7;
  t.deepEqual(vlans(intent), { switch: ["1: 6t 1 2 3 4", "20: 6t 1t 2t 3t 4t", "7: 6t 0t"], wan: "eth0.7" });
  intent.internet.lines[0].vlan = 20;
  t.throws(() => vlans(intent), { message: /VLAN 20 is both a network's and the line's/ });
});

test("the main connection's IPv6 moves with the role: promoting a backup or removing the main keeps it", (t) => {
  const main = { ...sample().internet.lines[0], ipv6: { enabled: true, prefix: "56" as const } };
  const backup = { ...main, id: "wanb", name: "LTE", ipv6: { enabled: false, prefix: "auto" as const } };
  t.like(withMain([main, backup], 1)[0], { id: "wanb", ipv6: { enabled: true, prefix: "56" } });
  t.deepEqual(withoutConnection([main, backup], 0).map((c) => [c.id, c.ipv6.enabled]), [["wanb", true]]);
  t.deepEqual(withoutConnection([main, backup], 1).map((c) => c.id), ["wan"]);
});

test("a radio that cannot mesh (facts say so) makes its device no mesh node", (t) => {
  const intent = sample();
  intent.wifi.mesh = { enabled: true, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: false, over_cable: false, large_frames: true };
  const oncConfig = compile(intent);
  const schema = deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "zyxel,nwa50ax-pro.json"), "utf8")));
  const on = (deviceSchema: typeof schema) =>
    getOpenWrtConfig({ oncConfig, deviceConfig: oncConfig.devices.find((d) => d.hostname === "home-ap-1")!, deviceSchema }) as any;
  const mesh = (config: any) => config.wireless["wifi-iface"].some((w: any) => w.mode === "mesh");
  t.true(mesh(on(schema)), "unknown: a node");
  t.false(mesh(on({ ...schema, radios: schema.radios!.map((r) => (r.band === "5g" ? { ...r, mesh: false } : r)) })));
});

test("two connections on one port (the WAN port unset and by name) are refused where the port is known", (t) => {
  const intent = sample();
  intent.internet.lines.push({ ...intent.internet.lines[0], id: "wanb", name: "Second", port: "eth1" });
  t.throws(() => onDevice("home-router", "friendlyarm,nanopi-r6s", intent), { message: /wan and wanb are both on port eth1/ });
});

test("port forwards: a range overlapping another's port is a clash; IPv6 sources are refused", (t) => {
  const intent = sample();
  const forward = (port: string, extra = {}) => ({
    name: `F ${port}`,
    enabled: true,
    protocol: "tcp" as const,
    port,
    to: { address: "10.0.0.20" },
    reflection: true,
    ...extra,
  });
  const issues = (port_forwards: unknown[]) =>
    (intentSchema.safeParse({ ...intent, firewall: { ...intent.firewall, port_forwards } }).error?.issues ?? []).map((i) => i.message);
  t.true(issues([forward("8000-8100"), forward("8080")]).includes("already forwarded"));
  t.deepEqual(issues([forward("8000-8100"), forward("8101")]), []);
  t.true(issues([forward("443", { from_addresses: ["2001:db8::1"] })]).some((m) => m.includes("IPv4 addresses only")));
});

test("a DNS server on a network this one cannot reach is refused", (t) => {
  const intent = sample();
  intent.networks[1].dhcp.dns_servers = ["10.0.0.53"];
  const r = intentSchema.safeParse(intent);
  t.true(!r.success && r.error.issues.some((i) => i.path.join(".") === "networks.1.dhcp.dns_servers.0"));
  intent.networks[1].access.networks = ["lan"];
  t.true(intentSchema.safeParse(intent).success);
});

test("the mesh over cables: 1532-byte frames on every DSA port, bridge and VLAN 4000; the networks' own devices held to 1500", (t) => {
  const intent = sample();
  intent.wifi.mesh = { enabled: true, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: false, over_cable: true, large_frames: true };
  const mtus = (host: string, model: string) =>
    Object.fromEntries(onDevice(host, model, intent).network.device.filter((d: any) => d.mtu).map((d: any) => [d.name, d.mtu]));
  t.deepEqual(mtus("home-router", "friendlyarm,nanopi-r6s"), {
    "br-lan.1": 1500,
    "br-lan.20": 1500,
    "br-lan": 1532,
    eth0: 1532,
    eth2: 1532,
    "br-lan.4000": 1532,
  }, "the WAN port (eth1) is not the bridge's: untouched");
  t.like(mtus("home-ap-1", "zyxel,nwa50ax-pro"), { "br-lan": 1532, eth0: 1532, mesh0: 1532, "br-lan.1": 1500 });
  intent.wifi.mesh.over_cable = false;
  t.deepEqual(mtus("home-router", "friendlyarm,nanopi-r6s"), {}, "not over cables: nothing changes");
});

test("larger frames over cable off: the mesh splits its packets there, and no MTU is touched", (t) => {
  const intent = sample();
  intent.wifi.mesh = { enabled: true, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: false, over_cable: true, large_frames: false };
  const devices = onDevice("home-router", "friendlyarm,nanopi-r6s", intent).network.device;
  t.deepEqual(devices.filter((d: any) => d.mtu), []);
});

test("odhcpd is re-bound when a network comes up, and restarted after a rollback", (t) => {
  const state = getOpenWrtState({
    oncConfig: compile(),
    deviceConfig: compile().devices.find((d) => d.hostname === "home-router")!,
    deviceSchema: deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "friendlyarm,nanopi-r6s.json"), "utf8"))),
  });
  t.like(state.services!.find((s) => s.name === "odhcpd"), { restart_after_rollback: true });
  const hook = state.files!.find((f) => f.path === "/etc/hotplug.d/iface/30-odhcpd-ra-fix")!.content;
  // Run it as netifd would, with odhcpd's init script and pidof stubbed.
  const dir = tempDir("hook");
  const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("pidof", "exit 0");
  stub("logger", "true");
  stub("sleep", "true");
  const script = hook.replace(/\/etc\/init\.d\/odhcpd restart/g, `echo restarted >> ${dir}/log`).replace(/\/tmp\/onc-/g, `${dir}/onc-`);
  const run = (iface: string, action = "ifup") =>
    spawnSync("sh", ["-c", `${script}\nwait`], { env: { PATH: `${dir}:/usr/bin:/bin`, ACTION: action, INTERFACE: iface }, encoding: "utf8" });
  run("guest");
  spawnSync("sleep", ["0.3"]);
  t.is(readFileSync(join(dir, "log"), "utf8").trim(), "restarted", "a network up: restarted");
  run("lan", "ifdown");
  run("somethingelse");
  spawnSync("sleep", ["0.3"]);
  t.is(readFileSync(join(dir, "log"), "utf8").trim().split("\n").length, 1, "down, or not ours: nothing");
});

test("on an access point, a network only carried has no IPv6, link-local included; the main one keeps it", (t) => {
  for (const model of ["zyxel,nwa50ax-pro", "tplink,archer-c50-v4"]) {
    const config = onDevice("home-ap-1", model);
    const devices = config.network.device.filter((d: any) => /^br-lan\.\d+$/.test(d.name));
    const guest = devices.find((d: any) => d.name !== "br-lan.1");
    t.is(guest?.ipv6, false, `${model}: the guests' VLAN device`);
    t.not(devices.find((d: any) => d.name === "br-lan.1")?.ipv6, false, `${model}: the main network's`);
  }
  // The router has addresses on every network (and its firewall): unchanged.
  const router = onDevice("home-router", "friendlyarm,nanopi-r6s");
  t.false(router.network.device.some((d: any) => d.ipv6 === false));
});

test("a rule's ports reach fw4 separated by spaces, however they were typed", (t) => {
  for (const typed of ["631,9100", "631, 9100", "631  9100"]) {
    const intent = sample();
    intent.firewall.rules[0].ports = typed;
    const rule = (compile(intent).config as any).firewall.rule.find((r: any) => r.name === "Guests may print");
    t.is(rule.dest_port, "631 9100", typed);
  }
  const bad = sample();
  bad.firewall.rules[0].ports = "631,,";
  t.false(intentSchema.safeParse(bad).success);
});


test("IPv6 follows the main line with several: a hook withdraws it while mwan3 has the line offline", (t) => {
  const intent = sample();
  intent.internet.lines[0].ipv6.enabled = true;
  t.false((compile(intent).files ?? []).some((f: any) => f.path.includes("ipv6-follows-line")), "one line: no hook");
  intent.internet.lines.push({ id: "wanb", name: "LTE", port: "eth2", type: "dhcp", ipv6: { enabled: false } });
  const hook = (compile(intent).files ?? []).find((f: any) => f.path === "/etc/hotplug.d/iface/17-onc-ipv6-follows-line") as any;
  t.truthy(hook);
  t.regex(hook.content, /disconnected\) .*ifdown wan6/);
  t.regex(hook.content, /connected\) .*\|\| ifup wan6/);
});

test("a network with its own DNS servers: odhcpd does not announce the router as IPv6 DNS", (t) => {
  const intent = sample();
  intent.internet.lines[0].ipv6.enabled = true;
  intent.networks[0].dhcp.dns_servers = ["10.0.0.53"];
  const dhcp = (compile(intent).config as any).dhcp.dhcp.find((d: any) => d[".name"] === intent.networks[0].id);
  const onRouter = dhcp[".overrides"].find((o: any) => /router/.test(o[".if"])).override;
  t.is(onRouter.dns_service, false);
  t.deepEqual(onRouter.dhcp_option.filter((o: string) => o.startsWith("6,")), ["6,10.0.0.53"]);
});

test("a port forward into a network that goes out through a VPN provider is refused: its replies would take the tunnel", async (t) => {
  const { newPrivateKey, publicKeyOf } = await import("../../wireguard");
  const intent = sample();
  intent.vpn = { ...intent.vpn, providers: [
    {
      id: "tun1",
      name: "Mullvad",
      private_key: newPrivateKey(),
      address: "10.64.12.34/32",
      dns: ["10.64.0.1"],
      peer: { public_key: publicKeyOf(newPrivateKey()), endpoint: "203.0.113.5:51820" },
    },
  ] };
  const forwardTo = (n: number) => {
    const net = intent.networks[n];
    return { ...intent, firewall: { ...intent.firewall, port_forwards: [{ ...intent.firewall.port_forwards[0], to: { address: net.subnet.replace(/\.0\/24$/, ".9") } }] } };
  };
  t.true(intentSchema.safeParse(forwardTo(1)).success, "out the plain line: fine");
  intent.networks[1].access = { ...intent.networks[1].access, via: "tun1", fallback: false };
  const refused = intentSchema.safeParse(forwardTo(1));
  t.false(refused.success);
  t.regex(JSON.stringify(refused.error?.issues), /goes out through a VPN provider/);
});

test("the router's mesh radio is as wide as the access points' in the mesh's band", (t) => {
  for (const [band, channel] of [["6g", 37], ["5g", 36]] as const) {
    const intent = sample();
    intent.wifi.radios = { ...(intent.wifi.radios ?? {}), "6g": { enabled: true } };
    intent.wifi.mesh = { enabled: true, band, channel, key: "mesh-key-123456", band_reserved: false, over_cable: false, large_frames: true };
    const devices = (compile(intent).config as any).wireless["wifi-device"].filter((d: any) => d.band === band);
    const widths = new Set(devices.map((d: any) => d.htmode));
    t.is(widths.size, 1, `${band}: ${[...widths].join(", ")}`);
  }
});

test("firewall addresses and ports are real ones; a port forward never targets the router", (t) => {
  const issuesOf = (edit: (intent: any) => void) => {
    const intent = sample();
    edit(intent);
    return intentSchema.safeParse(intent).error?.issues.map((i) => i.path.join(".")) ?? [];
  };
  t.deepEqual(issuesOf((i) => (i.firewall.rules[0].to_addresses = ["10.0.0.5/99"])), ["firewall.rules.0.to_addresses.0"]);
  t.deepEqual(issuesOf((i) => (i.firewall.rules[0].ports = "80 99999")), ["firewall.rules.0.ports"]);
  t.deepEqual(issuesOf((i) => (i.firewall.port_forwards[0].from_addresses = ["300.1.1.1"])), ["firewall.port_forwards.0.from_addresses.0"]);
  t.deepEqual(issuesOf((i) => (i.firewall.port_forwards[0].to.address = "10.0.0.999")), ["firewall.port_forwards.0.to.address"]);
  t.deepEqual(issuesOf((i) => (i.firewall.port_forwards[0].to.address = "10.0.0.1")), ["firewall.port_forwards.0.to.address"]);
  t.deepEqual(issuesOf((i) => (i.firewall.rules[0].to_addresses = ["2001:db8::/48"])), []);
});

test("an SSID broadcast on no band is refused, the mesh's reserved band included", (t) => {
  const intent = intentSchema.parse(sample());
  intent.wifi.radios["2g"].enabled = false;
  intent.wifi.mesh = { enabled: true, band: "5g", channel: 36, key: "mesh-key-123456", band_reserved: true, over_cable: false, large_frames: true };
  const paths = intentSchema.safeParse(intent).error?.issues.map((i) => i.path.join(".")) ?? [];
  t.true(paths.length > 0 && paths.every((p) => /^wifi\.networks\.\d+\.bands$/.test(p)), paths.join(", "));
  // And the UI greys out what would get there.
  intent.wifi.mesh.band_reserved = false;
  t.regex(String(availability(intent, "wifi.mesh.band_reserved").option(true).unavailable), /broadcast nowhere/);
  intent.wifi.radios["2g"].enabled = true;
  intent.wifi.mesh.band_reserved = true;
  t.regex(String(availability(intent, "wifi.radios.2g.enabled").option(false).unavailable), /broadcast nowhere/);
});

test("pinned channels: each band's own, the odd UNII-3 ones included", (t) => {
  const pin = (band: "2g" | "5g", channel: number) => {
    const intent = sample();
    intent.hardware[1].radios = { [band]: { channel } };
    return intentSchema.safeParse(intent).success;
  };
  t.true(pin("5g", 149));
  t.true(pin("5g", 165));
  t.true(pin("5g", 144));
  t.false(pin("5g", 38));
  t.false(pin("5g", 6));
  t.true(pin("2g", 13));
  t.false(pin("2g", 36));
});

test("the local domain may be one label or several, like home.arpa", (t) => {
  const withDomain = (domain: string) => {
    const intent = sample();
    intent.dns = { ...(intent.dns ?? {}), domain };
    return intent;
  };
  t.true(intentSchema.safeParse(withDomain("home.arpa")).success);
  t.false(intentSchema.safeParse(withDomain("home..arpa")).success);
  t.false(intentSchema.safeParse(withDomain("Home.arpa")).success);
  t.like((compile(withDomain("home.arpa")).config as any).dhcp.dnsmasq[0], { local: "/home.arpa/", domain: "home.arpa" });
});
