// Everything a device needs to run and be managed: time, SSH, the LuCI admin
// UI (kept as a fallback), and the configs this tool leaves alone.
import {
  everyDevice,
  Feature,
  onAccessPoints,
  onRouter,
  routerAddress,
} from "../fragment";
import { timezones } from "../timezones";

const ntpPool = [
  "162.159.200.123",
  "0.openwrt.pool.ntp.org",
  "1.openwrt.pool.ntp.org",
  "2.openwrt.pool.ntp.org",
  "3.openwrt.pool.ntp.org",
];

export const system: Feature = (intent) => {
  const router = routerAddress(intent);
  return {
    package_profiles: [{ ".if": everyDevice, packages: ["luci-ssl"] }],
    configs_to_not_reset: [
      {
        ".if": everyDevice,
        // LuCI's own state, and LEDs, which are per model.
        configs: ["luci.*", "rpcd.*", "ucitrack.*", "system.led"],
      },
    ],
    config: {
      system: {
        system: [
          {
            zonename: intent.site.timezone,
            timezone: timezones[intent.site.timezone],
            log_size: "2048",
          },
        ],
        timeserver: [
          {
            ".if": onRouter,
            ".name": "ntp",
            enable_server: true,
            interface: "lan",
            use_dhcp: false,
            server: ntpPool,
          },
          {
            ".if": onAccessPoints,
            ".name": "ntp",
            enable_server: false,
            use_dhcp: true,
            server: [router, ...ntpPool],
          },
        ],
      },
      dropbear: {
        dropbear: [
          {
            ".name": "main",
            PasswordAuth: "on",
            RootPasswordAuth: "on",
            Port: 22,
            Interface: "lan",
            BannerFile: "/etc/banner",
          },
        ],
      },
      uhttpd: {
        uhttpd: [
          {
            ".name": "main",
            listen_http: ["0.0.0.0:80", "[::]:80"],
            listen_https: ["0.0.0.0:443", "[::]:443"],
            ".overrides": [
              {
                // Not on the WAN side.
                ".if": onRouter,
                override: {
                  listen_http: [`${router}:80`],
                  listen_https: [`${router}:443`],
                },
              },
            ],
            redirect_https: true,
            home: "/www",
            rfc1918_filter: true,
            cert: "/etc/uhttpd.crt",
            key: "/etc/uhttpd.key",
            cgi_prefix: "/cgi-bin",
            lua_prefix: ["/cgi-bin/luci=/usr/lib/lua/luci/sgi/uhttpd.lua"],
            ubus_prefix: "/ubus",
            tcp_keepalive: true,
          },
        ],
        cert: [
          {
            ".name": "defaults",
            days: 397,
            key_type: "ec",
            ec_curve: "P-256",
            country: intent.site.country,
            commonname: "OpenWrt",
          },
        ],
      },
      attendedsysupgrade: { client: [{ ".name": "client" }] },
    },
  };
};
