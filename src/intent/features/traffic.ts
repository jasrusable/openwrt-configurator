// How much each device on the network downloads and uploads, for Status ›
// Clients: nlbwmon on the router, OpenWrt's own bandwidth monitor, with its
// stock settings (verified on 25.12.5). Its database lives under /var, which
// is RAM on OpenWrt: no flash wear, and a reboot starts it afresh.
import { Feature, onRouter } from "../fragment";

export const traffic: Feature = (intent) => ({
  package_profiles: [{ ".if": onRouter, packages: ["nlbwmon"] }],
  services: [{ ".if": onRouter, name: "nlbwmon", running: true }],
  config: {
    nlbwmon: {
      nlbwmon: [
        {
          ".if": onRouter,
          ".name": "nlbwmon",
          netlink_buffer_size: 524288,
          commit_interval: "24h",
          refresh_interval: "30s",
          database_directory: "/var/lib/nlbwmon",
          database_generations: 10,
          database_interval: "1",
          database_limit: 10000,
          protocol_database: "/usr/share/nlbwmon/protocols",
          // Your networks, and every private range: traffic between them is not the internet's.
          local_network: ["192.168.0.0/16", "172.16.0.0/12", "10.0.0.0/8", ...intent.networks.map((n) => n.id)],
        },
      ],
    },
  },
});
