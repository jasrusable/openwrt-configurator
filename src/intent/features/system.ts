// Everything a device needs to run and be managed: time, SSH, the LuCI admin
// UI (kept as a fallback), and the configs this tool leaves alone.
import {
  everyDevice,
  Feature,
  mainNetwork,
  onAccessPoints,
  onDevice,
  onRouter,
  routerAddress,
} from "../fragment";
import { timezones } from "../timezones";

// Cloudflare's by address first: with encrypted DNS the router cannot look a
// name up until its clock is right (TLS checks dates), so one server must
// need no lookup.
const ntpPool = [
  "162.159.200.123",
  "0.openwrt.pool.ntp.org",
  "1.openwrt.pool.ntp.org",
  "2.openwrt.pool.ntp.org",
  "3.openwrt.pool.ntp.org",
];

export const system: Feature = (intent) => {
  const router = routerAddress(intent);
  const main = mainNetwork(intent).id;
  return {
    package_profiles: [{ ".if": everyDevice, packages: ["luci-ssl"] }],
    // Who may log in as root. Listed keys replace the device's file; none
    // leaves a hand-installed one alone. dropbear reads it at each login.
    files: intent.admin.authorized_keys.length
      ? [
          {
            ".if": everyDevice,
            path: "/etc/dropbear/authorized_keys",
            mode: "0600",
            content: intent.admin.authorized_keys.join("\n") + "\n",
          },
        ]
      : [],
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
            // Each piece of hardware's location, as LuCI shows it.
            ".overrides": intent.hardware
              .filter((h) => h.location)
              .map((h) => ({ ".if": onDevice(h.name), override: { description: h.location } })),
            zonename: intent.site.timezone,
            timezone: timezones[intent.site.timezone],
            log_size: "2048",
          },
        ],
        timeserver: [
          {
            ".if": onRouter,
            ".name": "ntp",
            // On every network: the firewall decides who may ask (WAN may not).
            enable_server: true,
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
            // Off: only the authorized keys (below) let root in. A stock
            // device has no root password and accepts any, so this is what
            // closes it.
            PasswordAuth: intent.admin.password_login ? "on" : "off",
            RootPasswordAuth: intent.admin.password_login ? "on" : "off",
            Port: 22,
            // Only on the main network: guests and IoT get no SSH. Bound to
            // its device, not an address, so an address from DHCP (as access
            // points have) changing later does not matter.
            DirectInterface: main,
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
            // As 25.12 ships it with LuCI, but HTTPS only. LuCI is the CGI
            // program /www/cgi-bin/luci (ucode) now: cgi_prefix is what serves
            // it, and the Lua entry stock still lists no longer exists.
            redirect_https: true,
            home: "/www",
            rfc1918_filter: true,
            max_requests: 3,
            max_connections: 100,
            cert: "/etc/uhttpd.crt",
            key: "/etc/uhttpd.key",
            cgi_prefix: "/cgi-bin",
            // LuCI talks to the router over /ubus; first boot adds it with
            // uhttpd-mod-ubus (00_uhttpd_ubus), so the wipe must keep it.
            ubus_prefix: "/ubus",
            script_timeout: 60,
            network_timeout: 30,
            http_keepalive: 20,
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
