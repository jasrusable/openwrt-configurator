// The networks, on every device. Each is a VLAN: the main network VLAN 1,
// untagged on every port; the others tagged on every port, so a router port
// is a trunk and an access point plugged in anywhere gets every network.
// The router routes and serves each network (addresses, IPv6, DHCP); every
// other device is a client of the main network and only bridges the rest.
import {
  everyDevice,
  Feature,
  gatewayOf,
  Network,
  onAccessPoints,
  onRouter,
} from "../fragment";

/**
 * A stable unique-local IPv6 prefix for the site. RFC 4193 wants the 40-bit
 * global ID random; derived from the site name it is still unlikely to clash,
 * and it never changes unless the name does, without being stored anywhere.
 */
export const ulaPrefix = (siteName: string) => {
  // FNV-1a, 32-bit: two runs give 64 bits, of which 40 are used.
  const fnv = (text: string) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const hex = fnv(siteName) + fnv(`${siteName}/ula`);
  return `fd${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6, 10)}::/48`;
};

/** The bridge VLAN a network rides on: 1 for the main network. */
const vlanOf = (network: Network) => network.vlan ?? 1;
const deviceOf = (network: Network) => `br-lan.${vlanOf(network)}`;
const isMain = (network: Network) => network.vlan === undefined;

/** One per network, so each gets its own /64 of the delegated prefix. */
const ip6hint = (network: Network) => vlanOf(network).toString(16);

const routerInterface = (network: Network) => ({
  proto: "static",
  ipaddr: gatewayOf(network),
  netmask: "255.255.255.0",
  ...(network.ipv6
    ? { ip6assign: "64", ip6hint: ip6hint(network), ip6class: ["wan6", "local"] }
    : {}),
});

const dhcpServer = (network: Network) => ({
  force: true,
  // The pool ends at .254, so the low addresses stay free.
  start: 255 - network.dhcp.size,
  limit: network.dhcp.size,
  leasetime: network.dhcp.lease,
  dhcpv4: "server",
  ...(network.ipv6
    ? {
        dhcpv6: "server",
        ra: "server",
        ra_default: 2,
        ra_slaac: true,
        ra_flags: ["managed-config", "other-config"],
      }
    : { dhcpv6: "disabled", ra: "disabled" }),
  // Option 42: the router is the network's time server.
  dhcp_option: [`42,${gatewayOf(network)}`],
});

export const network: Feature = (intent) => {
  const { networks } = intent;
  const main = networks.find(isMain)!;
  return {
    config: {
      network: {
        // The VLANs, on each kind of switch: DSA bridges VLAN-filter in the
        // bridge; older swconfig switches tag in the switch, one bridge per VLAN.
        ".overrides": [
          {
            ".if": "device.sw_config == true",
            override: {
              switch: [{ name: "switch0", reset: true, enable_vlan: true }],
              switch_vlan: networks.map((n) => ({
                device: "switch0",
                vlan: vlanOf(n),
                ports: isMain(n) ? "*" : "*t",
              })),
              device: networks.map((n) => ({
                name: deviceOf(n),
                type: "bridge",
                ports: [`@cpu_port.${vlanOf(n)}`],
              })),
            },
          },
          {
            ".if": "device.sw_config == false",
            override: {
              device: [{ name: "br-lan", type: "bridge", ports: "*" }],
              "bridge-vlan": networks.map((n) => ({
                device: "br-lan",
                vlan: vlanOf(n),
                ports: isMain(n) ? "*" : "*t",
              })),
            },
          },
        ],
        interface: [
          {
            ".name": "loopback",
            device: "lo",
            proto: "static",
            ipaddr: "127.0.0.1",
            netmask: "255.0.0.0",
          },
          ...networks.map((n) => ({
            ".name": n.id,
            device: deviceOf(n),
            delegate: false,
            ".overrides": [
              { ".if": onRouter, override: routerInterface(n) },
              {
                // Access points: a client of the main network; the others
                // only carried, for their Wi-Fi to join.
                ".if": onAccessPoints,
                override: isMain(n) ? { proto: "dhcp", ipv6: false } : { proto: "none" },
              },
            ],
          })),
          ...(main.ipv6
            ? [
                {
                  ".if": onAccessPoints,
                  ".name": `${main.id}6`,
                  device: deviceOf(main),
                  proto: "dhcpv6",
                  reqprefix: "no",
                },
              ]
            : []),
        ],
        globals: [
          {
            ".name": "globals",
            ".overrides": [
              {
                ".if": onRouter,
                override: {
                  ula_prefix: networks.some((n) => n.ipv6)
                    ? ulaPrefix(intent.site.name)
                    : "",
                },
              },
              { ".if": onAccessPoints, override: { ula_prefix: "" } },
            ],
          },
        ],
      },
      dhcp: {
        dhcp: networks.map((n) => ({
          ".name": n.id,
          interface: n.id,
          ".overrides": [
            { ".if": onRouter, override: dhcpServer(n) },
            {
              ".if": onAccessPoints,
              override: {
                ignore: true,
                dhcpv4: "disabled",
                dhcpv6: "disabled",
                ra: "disabled",
                ndp: "disabled",
              },
            },
          ],
        })),
        odhcpd: [
          {
            ".if": everyDevice,
            ".name": "odhcpd",
            leasefile: "/tmp/odhcpd.leases",
            leasetrigger: "/usr/sbin/odhcpd-update",
            hostsdir: "/tmp/hosts",
            piodir: "/tmp/odhcpd-piodir",
          },
        ],
      },
    },
  };
};
