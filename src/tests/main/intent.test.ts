import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { getOpenWrtState } from "../../getOpenWrtState";
import { compileIntent } from "../../intent/compile";
import { ulaPrefix } from "../../intent/features/network";
import { migrateIntent } from "../../intent/migrations";
import { intentSchema } from "../../intent/schema";
import { oncConfigSchema } from "../../oncConfigSchema";

const root = join(__dirname, "../../..");
const sample = () =>
  JSON.parse(readFileSync(join(root, "sampleConfigs/intent.json"), "utf8"));
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
    ]
  );
  t.deepEqual(config.dhcp.dnsmasq[0].interface, ["lan", "guest"]);
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
      "Allow-guest-DHCP",
      "Allow-guest-DHCPv6",
      "Allow-guest-DNS",
      "Allow-guest-NTP",
      "Allow-guest-ICMPv6",
      "Guests may print",
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

test("the firewall derives from each network's access; own rules come last", (t) => {
  const intent = sample();
  intent.networks[1].access = { internet: false, networks: ["lan"], router: "full" };
  intent.firewall.rules.push(
    { name: "No IoT out", from: "guest", to: "internet", protocol: "any", action: "block" },
    { name: "Scanners", from: "internet", to: "*", source_addresses: ["2001:db8::/32"], action: "block" }
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
  t.is(names[0], "Allow-DHCP-Renew", "stock rules first");
  t.deepEqual(names.slice(-3), ["Guests may print", "No IoT out", "Scanners"], "own rules last, in order");
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
  const config = router((i) => (i.internet.connections[0].vlan = 10));
  t.is(iface(config, "wan").device, "eth1.10", "@wan_port.10 is the WAN port's VLAN 10");
  t.is(config.sqm.queue[0].interface, "eth1", "shaped on the port, under the tag");
  t.like(config.sqm.queue[0], { linklayer: "ethernet", overhead: "42" });
  t.like(router(() => {}).sqm.queue[0], { overhead: "38", tcMPU: 84 });
});

test("internet: the line type sets queueing's overhead", (t) => {
  const line = (type: string) =>
    router((i) => (i.internet.connections[0].speed.line = type)).sqm.queue[0];
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
    i.internet.connections[0].connection = {
      type: "static",
      address: "203.0.113.10",
      prefix_length: 29,
      gateway: "203.0.113.9",
      dns: ["9.9.9.9"],
    };
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
    intent.internet.connections[0].connection = { type: "static", prefix_length: 29, ...connection };
    if (!dohOn) intent.dns.upstream = { type: "provider" };
    return intentSchema.safeParse(intent).error?.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`
    );
  };
  t.deepEqual(issues({ address: "203.0.113.8", gateway: "203.0.113.9" }), [
    "internet.connections.0.connection.address: the subnet's own or broadcast address, not a host's",
  ]);
  t.deepEqual(issues({ address: "203.0.113.10", gateway: "203.0.113.20" }), [
    "internet.connections.0.connection.gateway: not in the address's subnet",
  ]);
  t.deepEqual(issues({ address: "203.0.113.10", gateway: "203.0.113.9" }, false), [
    "internet.connections.0.connection.dns: add a DNS server, or choose other DNS servers under DNS & DHCP",
  ]);
  t.deepEqual(issues({ address: "203.0.113.300", gateway: "203.0.113.9" }), [
    "internet.connections.0.connection.address: an IPv4 address, like 203.0.113.10",
  ]);
});

test("internet: IPv6 asks for the prefix size; PPPoE gets an explicit wan6", (t) => {
  const config = router((i) => {
    i.internet.connections[0].connection = { type: "pppoe", username: "u", password: "p" };
    i.internet.connections[0].ipv6_prefix = "56";
  });
  t.like(iface(config, "wan"), { proto: "pppoe", ipv6: "1" });
  t.like(iface(config, "wan6"), { device: "@wan", proto: "dhcpv6", reqprefix: "56" });
  t.false("reqprefix" in iface(router(() => {}), "wan6"), "automatic asks for nothing");

  const intent = sample();
  intent.internet.connections[0].ipv6_prefix = "64";
  intent.networks[1].ipv6 = true;
  t.deepEqual(
    intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ["internet.connections.0.ipv6_prefix: 2 networks have IPv6, and a /64 has room for 1."]
  );
});

test("packages are fixed per role; a setting off is config, not a removal", (t) => {
  const packages = (intent: any) =>
    (compile(intent).package_profiles ?? []).flatMap((p: any) => p.packages);
  const off = sample();
  delete off.internet.connections[0].speed;
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
  const off = router((i) => (i.internet.connections[0].ipv6 = false));
  t.false("ip6assign" in off.network.interface.find((i: any) => i[".name"] === "lan"));
  t.like(off.dhcp.dhcp.find((d: any) => d.interface === "lan"), { ra: "disabled", dhcpv6: "disabled" });
  t.is(off.network.globals[0].ula_prefix, "");
  t.false(off.network.interface.some((i: any) => i[".name"] === "wan6"));

  const intent = sample();
  intent.internet.connections[0].ipv6 = false;
  const ap = onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent);
  t.false(ap.network.interface.some((i: any) => i[".name"] === "lan6"), "the AP takes no IPv6 address either");
});

test("reserved addresses: a fixed lease and a DNS name, checked against the network", (t) => {
  const config = router((i) => {
    i.networks[0].reservations = [{ name: "nas", mac: "aa:bb:cc:dd:ee:01", address: "10.0.0.20" }];
  });
  t.is(config.dhcp.host.length, 1);
  t.like(config.dhcp.host[0], { name: "nas", mac: "aa:bb:cc:dd:ee:01", ip: "10.0.0.20", dns: true });
  const issues = (reservations: any[], network = 0) => {
    const intent = sample();
    intent.networks[network].reservations = reservations;
    return intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  const nas = { name: "nas", mac: "aa:bb:cc:dd:ee:01", address: "10.0.0.20" };
  t.deepEqual(issues([{ ...nas, address: "10.0.20.5" }]), ["networks.0.reservations.0.address: an address in 10.0.0.x"]);
  t.deepEqual(issues([{ ...nas, address: "10.0.0.1" }]), [
    "networks.0.reservations.0.address: 10.0.0.2 to 10.0.0.254 (.1 is the router)",
  ]);
  t.deepEqual(issues([nas, { ...nas, address: "10.0.0.21" }]), [
    "networks.0.reservations.1.name: already used",
    "networks.0.reservations.1.mac: already used",
  ]);
  t.deepEqual(issues([{ ...nas, name: "home-router" }]), [
    "networks.0.reservations.0.name: already a device's name",
  ]);
  t.deepEqual(issues([{ ...nas, mac: "AA-BB" }]), ["networks.0.reservations.0.mac: like aa:bb:cc:dd:ee:ff"]);
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
    change(intent.wifi[1]);
    return onDevice("home-ap-1", "zyxel,nwa50ax-pro", intent).wireless["wifi-iface"].find(
      (w: any) => w.ssid === intent.wifi[1].ssid
    );
  };
  t.like(iface(() => {}), { encryption: "psk2+ccmp", ieee80211r: true });
  t.is(iface((w) => (w.security = "wpa2-wpa3")).encryption, "sae-mixed");
  t.is(iface((w) => (w.security = "wpa3")).encryption, "sae");
  t.like(iface((w) => Object.assign(w, { hidden: true, enabled: false })), { hidden: true, disabled: true });
  const slow = iface((w) => (w.fast_roaming = false));
  t.is(slow.ieee80211r, false);
  t.true(slow.bss_transition, "802.11v stays on");
  t.false("ft_over_ds" in iface(() => {}), "OpenWrt's default: over the air");
  t.like(iface((w) => (w.roaming_assistance = false)), { ieee80211k: false, bss_transition: false });
  // Steering Off turns neighbour lists off on every SSID, whatever each says.
  const offEverywhere = sample();
  offEverywhere.roaming = { steering: "off", prefer_5g: false };
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
  t.deepEqual(usteer((i) => (i.wifi[1].roaming_assistance = false)).ssid_list, ["Home"]);
  t.deepEqual(usteer((i) => (i.wifi[0].enabled = false)).ssid_list, ["Home Guests"]);
  // An empty ssid_list would mean every SSID: with none taking part, usteer stops.
  t.like(
    usteer((i) => i.wifi.forEach((w: any) => (w.roaming_assistance = false))),
    { enabled: false }
  );

  // Wi-Fi › Roaming: off stops usteer and neighbour lists; advise moves
  // nothing; nudge asks; push asks, then disconnects. aggressiveness is
  // always set: its default (3) would kick.
  const roaming = (steering: string, prefer_5g = false) =>
    usteer((i) => (i.roaming = { steering, prefer_5g }));
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
  intent.wifi[0].security = "wpa3";
  t.deepEqual(
    intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ["wifi.0.extra_passwords: Only with WPA2: WPA3 has one password per network."]
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

  t.false("rebind_protection" in dns((i) => (i.dns.rebind_protection = false)).dnsmasq);

  const named = dns((i) => (i.dns.records = [{ name: "printer", address: "10.0.0.30" }])).config;
  t.like(named.dhcp.domain[0], { name: "printer", ip: "10.0.0.30" });

  const piHole = dns((i) => (i.networks[1].dhcp.dns_servers = ["10.0.0.53"])).config;
  t.deepEqual(piHole.dhcp.dhcp.find((d: any) => d.interface === "guest").dhcp_option, ["42,10.0.20.1", "6,10.0.0.53"]);

  const issues = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    return intentSchema.safeParse(intent).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  t.deepEqual(issues((i) => (i.dns.records = [{ name: "a", address: "x" }, { name: "a", address: "10.0.0.2" }])), [
    "dns.records.0.address: an IP address, like 10.0.0.20",
    "dns.records.1.name: already used",
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
  ]);
  t.deepEqual(files("home-ap-1", "zyxel,nwa50ax-pro"), [
    "/etc/hotplug.d/net/20-aql",
    "/usr/libexec/onc/ubihealthd-config",
  ]);
  t.deepEqual(
    files("home-router", "friendlyarm,nanopi-r6s", (i) => (i.internet.connections[0].ipv6 = false)).filter(
      (p: string) => !p.includes("avahi")
    ),
    ["/usr/libexec/platform/packet-steering.sh", "/usr/libexec/onc/ubihealthd-config"],
    "the odhcpd fix only where the internet's IPv6 is on"
  );
});

test("airtime: each band's queue limits, on the access points", (t) => {
  const aql = (radios: object) => {
    const intent = sample();
    intent.radios = { ...(intent.radios ?? {}), ...radios };
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
  intent.radios = {
    "2g": { enabled: true, width: "auto", power: "low", cell_density: "off" },
    "5g": { enabled: true, width: "160", power: "auto", cell_density: "high" },
    "6g": { enabled: true },
  };
  intent.wifi[1].bands = ["2g"];
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
  t.throws(bad((i) => (i.site.timezone = "Mars/Olympus")), {
    message: /IANA zone/,
  });
  t.throws(bad((i) => (i.wifi[0].password = "short")), {
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
  t.deepEqual(issues((i) => (i.wifi[1].network = "gone")), [
    "wifi.1.network: pick a network",
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
    "wifi.1.network: pick a network",
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
  t.deepEqual(issues((i) => i.firewall.rules[0].destination_addresses.push("fd00::1")), [
    "firewall.rules.0.destination_addresses: IPv4 and IPv6 addresses cannot share a rule",
  ]);
  t.deepEqual(
    issues((i) => (i.firewall.port_forwards[0].internal_address = "192.168.9.9")),
    ["firewall.port_forwards.0.internal_address: not on any of your networks"]
  );
  t.deepEqual(
    issues((i) =>
      i.firewall.port_forwards.push({ ...i.firewall.port_forwards[0], name: "Again", protocol: "tcp+udp" })
    ),
    ["firewall.port_forwards.1.external_port: already forwarded"]
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
    intent.internet.mode = mode;
    intent.internet.connections.push({
      id: "wanb",
      name: "LTE",
      port: "eth2",
      connection: { type: "dhcp" },
      ipv6: true,
      speed: { down_mbps: 50, up_mbps: 10 },
      weight: 3,
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

  const shared = onDevice("home-router", "friendlyarm,nanopi-r6s", twoLines("balance"));
  t.deepEqual(shared.mwan3.member.map((m: any) => [m.metric, m.weight]), [[1, 1], [1, 3]]);
  t.deepEqual(shared.mwan3.rule.map((r: any) => r[".name"]), ["https", "default"], "secure sites keep to one line");

  const packages = compile(twoLines("failover")).package_profiles!.flatMap((p: any) => p.packages);
  t.true(packages.includes("mwan3"));
  t.false(compile().package_profiles!.flatMap((p: any) => p.packages).includes("mwan3"), "one line: no mwan3");
  t.is(onDevice("home-router", "friendlyarm,nanopi-r6s").mwan3, undefined);
});

test("connections: one per port, the WAN port once, ids of their own", (t) => {
  const issues = (change: (i: any) => void) => {
    const intent = sample();
    change(intent);
    const result = intentSchema.safeParse(intent);
    return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  const second = { id: "wanb", name: "LTE", connection: { type: "dhcp" } };
  t.deepEqual(issues((i) => i.internet.connections.push(second)), [
    "internet.connections.1.port: Fibre uses the WAN port.",
  ]);
  t.deepEqual(
    issues((i) => {
      i.internet.connections[0].port = "eth2";
      i.internet.connections.push({ ...second, port: "eth2" });
    }),
    ["internet.connections.1.port: Fibre uses it."]
  );
  t.true(issues((i) => (i.networks[1].id = "wanx")).some((m) => m.endsWith("reserved")));
});

test("several lines: a network keeps to one, a metered line is a last resort, a slow line counts as down, devices keep to a line", (t) => {
  const intent = sample();
  intent.internet.mode = "balance";
  intent.internet.share_per_device = true;
  intent.internet.connections.push({
    id: "wanb",
    name: "LTE",
    port: "eth2",
    connection: { type: "dhcp" },
    ipv6: false,
    ipv6_prefix: "auto",
    weight: 1,
    metered: true,
    down_when_slow: true,
  });
  intent.networks[1].line = { connection: "wanb", fallback: false };
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

  intent.networks[1].line = { connection: "wanb", fallback: true };
  const fallback = onDevice("home-router", "friendlyarm,nanopi-r6s", intent).mwan3;
  t.deepEqual(fallback.policy.find((p: any) => p[".name"] === "via_guest").use_member, ["wanb_m1", "wan_m2"]);

  intent.networks[1].line = { connection: "wanz", fallback: true };
  t.true(
    (intentSchema.safeParse(intent) as any).error.issues.some((i: any) => i.path.join(".") === "networks.1.line.connection")
  );
});
