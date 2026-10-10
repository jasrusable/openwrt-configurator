// The router's internet side: the WAN connection, and smart queueing when the
// line's speed is known. The firewall is its own feature (firewall.ts).
import { Feature, onRouter } from "../fragment";

export const internet: Feature = (intent) => {
  const { connection, ipv6, speed } = intent.internet;
  // With encrypted DNS the ISP's resolvers must not be used.
  const peerdns = !intent.dns.over_https;
  const routerOnly = (sections: Record<string, unknown>[]) =>
    sections.map((section) => ({ ".if": onRouter, ...section }));

  return {
    package_profiles: speed
      ? [{ ".if": onRouter, packages: ["sqm-scripts", "luci-app-sqm"] }]
      : [],
    config: {
      network: {
        interface: routerOnly([
          {
            ".name": "wan",
            device: "@wan_port",
            peerdns,
            ...(connection.type === "pppoe"
              ? {
                  proto: "pppoe",
                  username: connection.username,
                  password: connection.password,
                  ipv6: ipv6 ? "auto" : false,
                }
              : { proto: "dhcp" }),
          },
          ...(ipv6 && connection.type === "dhcp"
            ? [{ ".name": "wan6", device: "@wan", proto: "dhcpv6", peerdns }]
            : []),
        ]),
      },
      ...(speed
        ? {
            sqm: {
              queue: routerOnly([
                {
                  ".name": "wan",
                  enabled: true,
                  interface: "@wan_port",
                  download: String(Math.round(speed.down_mbps * 1000)),
                  upload: String(Math.round(speed.up_mbps * 1000)),
                  qdisc: "cake",
                  script: "piece_of_cake.qos",
                  linklayer: "ethernet",
                  overhead: "38",
                  linklayer_advanced: "1",
                  tcMPU: 84,
                },
              ]),
            },
          }
        : {}),
    },
  };
};
