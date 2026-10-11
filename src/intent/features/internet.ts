// The router's internet side: the WAN connection, and smart queueing when the
// line's speed is known. The firewall is its own feature (firewall.ts).
import { Feature, mainNetwork, onRouter } from "../fragment";
import { fnv } from "./network";
import { lineTypes, netmask } from "../schema";

/**
 * Per-packet overhead by line, as OpenWrt's SQM guidance gives it: fibre is
 * plain Ethernet (cake's "ethernet", "ether-vlan" when tagged), cable is
 * DOCSIS, VDSL the conservative 34 (PTM, PPPoE and a VLAN), ADSL ATM cells.
 */
const lineOverhead = (
  line: (typeof lineTypes)[number],
  tagged: boolean,
): Record<string, unknown> =>
  ({
    fibre: { linklayer: "ethernet", overhead: tagged ? "42" : "38", tcMPU: 84 },
    cable: { linklayer: "ethernet", overhead: "18", tcMPU: 64 },
    vdsl: { linklayer: "ethernet", overhead: "34" },
    adsl: { linklayer: "atm", overhead: "44" },
  })[line];

/**
 * The router's UPnP identity. miniupnpd writes a random one back to UCI when
 * none is set, which the next provision would wipe: derived from the site
 * instead, it stays the same and clients keep seeing the same router.
 */
const upnpUuid = (siteName: string) => {
  const hex = [1, 2, 3, 4].map((n) => fnv(`${siteName}/upnp${n}`)).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

export const internet: Feature = (intent) => {
  const { connection, vlan, ipv6, ipv6_prefix, upnp, speed } = intent.internet;
  const main = mainNetwork(intent);
  // With encrypted DNS the ISP's resolvers must not be used.
  const peerdns = !intent.dns.over_https;
  const ptm = speed?.line === "vdsl" ? " ptm" : "";
  const routerOnly = (sections: Record<string, unknown>[]) =>
    sections.map((section) => ({ ".if": onRouter, ...section }));

  const proto =
    connection.type === "pppoe"
      ? {
          proto: "pppoe",
          username: connection.username,
          password: connection.password,
          // IPv6CP only: wan6 below asks for the prefix, at the size wanted.
          ipv6: ipv6 ? "1" : false,
        }
      : connection.type === "static"
        ? {
            proto: "static",
            ipaddr: connection.address,
            netmask: netmask(connection.prefix_length),
            gateway: connection.gateway,
            ...(connection.dns?.length ? { dns: connection.dns } : {}),
          }
        : { proto: "dhcp" };

  return {
    // Installed whether used or not: a setting changes config, not packages.
    package_profiles: [
      {
        ".if": onRouter,
        packages: [
          "sqm-scripts",
          "luci-app-sqm",
          "miniupnpd-nftables",
          "luci-app-upnp",
        ],
      },
    ],
    config: {
      network: {
        interface: routerOnly([
          {
            ".name": "wan",
            // A tagged line: netifd makes the VLAN device from the name.
            device: vlan ? `@wan_port.${vlan}` : "@wan_port",
            ...(connection.type === "static" ? {} : { peerdns }),
            ...proto,
          },
          ...(ipv6
            ? [
                {
                  ".name": "wan6",
                  device: "@wan",
                  proto: "dhcpv6",
                  peerdns,
                  ...(ipv6_prefix === "auto" ? {} : { reqprefix: ipv6_prefix }),
                },
              ]
            : []),
        ]),
      },
      // Declared on or off: with its section missing, miniupnpd's init script
      // defaults to enabled. Its firewall hooks are nftables.d includes.
      upnpd: {
        upnpd: routerOnly([
          {
            ".name": "config",
            enabled: upnp,
            enable_upnp: true,
            enable_natpmp: true,
            // A device may only open ports to itself.
            secure_mode: true,
            log_output: false,
            internal_iface: main.id,
            port: 5000,
            upnp_lease_file: "/var/run/miniupnpd.leases",
            igdv1: true,
            uuid: upnpUuid(intent.site.name),
          },
        ]),
        perm_rule: routerOnly([
          {
            action: "allow",
            ext_ports: "1024-65535",
            int_addr: main.subnet,
            int_ports: "1024-65535",
            comment: "Main network, high ports",
          },
          {
            action: "deny",
            ext_ports: "0-65535",
            int_addr: "0.0.0.0/0",
            int_ports: "0-65535",
            comment: "Default deny",
          },
        ]),
      },
      sqm: {
        queue: routerOnly([
          speed
            ? {
                ".name": "wan",
                enabled: true,
                // The port itself, so the overhead counts every header on it.
                interface: "@wan_port",
                download: String(Math.round(speed.down_mbps * 1000)),
                upload: String(Math.round(speed.up_mbps * 1000)),
                qdisc: "cake",
                script: "piece_of_cake.qos",
                linklayer_advanced: "1",
                ...lineOverhead(speed.line, vlan !== undefined),
                // Fair per device behind the NAT; "ingress" counts what cake
                // drops too, so the download rate holds. VDSL2's 64/65
                // encoding is "ptm". The flags only make LuCI show them.
                qdisc_advanced: "1",
                qdisc_really_really_advanced: "1",
                iqdisc_opts: `nat dual-dsthost ingress${ptm}`,
                eqdisc_opts: `nat dual-srchost${ptm}`,
              }
            : { ".name": "wan", enabled: false, interface: "@wan_port" },
        ]),
      },
    },
  };
};
