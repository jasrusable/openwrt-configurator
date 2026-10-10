// The home network: every port bridged into it, the router serving addresses
// (IPv4 DHCP, IPv6 router advertisements and DHCPv6), and every other device
// a client of it.
import {
  everyDevice,
  Feature,
  onAccessPoints,
  onRouter,
  routerAddress,
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

export const network: Feature = (intent) => {
  const { dhcp, ipv6 } = intent.network;
  const router = routerAddress(intent);
  return {
    config: {
      network: {
        // Every port nothing else uses (the router's WAN port is used by the
        // wan interface). On older swconfig devices, through the switch.
        ".overrides": [
          {
            ".if": "device.sw_config == true",
            override: {
              switch: [{ name: "switch0", reset: true, enable_vlan: true }],
              switch_vlan: [{ device: "switch0", vlan: 1, ports: "*" }],
              device: [
                { name: "br-lan", type: "bridge", ports: ["@cpu_port.1"] },
              ],
            },
          },
          {
            ".if": "device.sw_config == false",
            override: {
              device: [{ name: "br-lan", type: "bridge", ports: "*" }],
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
          {
            ".name": "lan",
            device: "br-lan",
            delegate: false,
            ".overrides": [
              {
                ".if": onRouter,
                override: {
                  proto: "static",
                  ipaddr: router,
                  netmask: "255.255.255.0",
                  ...(ipv6
                    ? { ip6assign: "64", ip6hint: "1", ip6class: ["wan6", "local"] }
                    : {}),
                },
              },
              {
                ".if": onAccessPoints,
                override: { proto: "dhcp", ipv6: false },
              },
            ],
          },
          ...(ipv6
            ? [
                {
                  ".if": onAccessPoints,
                  ".name": "lan6",
                  device: "br-lan",
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
                override: { ula_prefix: ipv6 ? ulaPrefix(intent.site.name) : "" },
              },
              { ".if": onAccessPoints, override: { ula_prefix: "" } },
            ],
          },
        ],
      },
      dhcp: {
        dhcp: [
          {
            ".name": "lan",
            interface: "lan",
            ".overrides": [
              {
                ".if": onRouter,
                override: {
                  force: true,
                  // The pool ends at .254, so the low addresses stay free.
                  start: 255 - dhcp.size,
                  limit: dhcp.size,
                  leasetime: dhcp.lease,
                  dhcpv4: "server",
                  ...(ipv6
                    ? {
                        dhcpv6: "server",
                        ra: "server",
                        ra_default: 2,
                        ra_slaac: true,
                        ra_flags: ["managed-config", "other-config"],
                      }
                    : { dhcpv6: "disabled", ra: "disabled" }),
                  // Option 42: the router is the network's time server.
                  dhcp_option: [`42,${router}`],
                },
              },
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
          },
        ],
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
