// Everything a device needs to run and be managed: time, SSH, the LuCI admin
// UI (kept as a fallback), and the configs this tool leaves alone.
import { PlanFile, section } from "../../plan/types";
import { everyDevice, Feature, mainNetwork, onAccessPoints, onDevice, onRouter, routerAddress } from "../fragment";
import { timezones } from "./timezones";

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

/**
 * Root's password, the one this app logs in with. A stock device has none,
 * and then rpcd (LuCI, and this app on a router) takes any password, so
 * setting it is what closes the web logins. passwd reads it twice from the
 * file, never from a command line; the file changes only with the password,
 * so an apply that keeps it runs nothing. Not rewound by a rollback: it is
 * the password the app then logs back in with.
 */
const rootPasswordFile = "/etc/onc/root-password";
const rootPassword = (password: string): PlanFile => ({
  when: everyDevice,
  path: rootPasswordFile,
  mode: "0600",
  content: `${password}\n${password}\n`,
  runAfter: `passwd root < ${rootPasswordFile} > /dev/null`,
});

export const system: Feature = (intent) => {
  const router = routerAddress(intent);
  const main = mainNetwork(intent).id;
  return {
    packages: [{ when: everyDevice, add: ["luci-ssl"] }],
    services: [
      { when: everyDevice, name: "system" },
      { when: everyDevice, name: "sysntpd", running: true },
      { when: everyDevice, name: "dropbear", running: true },
      { when: everyDevice, name: "uhttpd", running: true },
    ],
    // Who may log in as root. Listed keys replace the device's file; none
    // leaves a hand-installed one alone. dropbear reads it at each login.
    files: [
      ...(intent.system.ssh.authorized_keys.length
        ? [
            {
              when: everyDevice,
              path: "/etc/dropbear/authorized_keys",
              mode: "0600",
              content: intent.system.ssh.authorized_keys.join("\n") + "\n",
            },
          ]
        : []),
      ...(intent.system.app_login.password ? [rootPassword(intent.system.app_login.password)] : []),
    ],
    keep: [
      {
        when: everyDevice,
        // LuCI's own state, and LEDs, which are per model.
        entries: [{ config: "luci" }, { config: "rpcd" }, { config: "ucitrack" }, { config: "system", type: "led" }],
      },
    ],
    config: {
      system: {
        system: [
          section(
            {
              // Each piece of hardware's location, as LuCI shows it.
              overrides: intent.hardware
                .filter((h) => h.location)
                .map((h) => ({ when: onDevice(h.name), options: { description: h.location! } })),
            },
            { zonename: intent.system.timezone, timezone: timezones[intent.system.timezone], log_size: "2048" }
          ),
        ],
        timeserver: [
          // On every network: the firewall decides who may ask (WAN may not).
          section({ name: "ntp", when: onRouter }, { enable_server: true, use_dhcp: false, server: ntpPool }),
          section({ name: "ntp", when: onAccessPoints }, { enable_server: false, use_dhcp: true, server: [router, ...ntpPool] }),
        ],
      },
      dropbear: {
        dropbear: [
          section({ name: "main" }, {
            // Off: only the authorized keys (below) let root in. A stock
            // device has no root password and accepts any, so this is what
            // closes it.
            PasswordAuth: intent.system.ssh.password_login ? "on" : "off",
            RootPasswordAuth: intent.system.ssh.password_login ? "on" : "off",
            Port: 22,
            // Only on the main network: guests and IoT get no SSH. Bound to
            // its device, not an address, so an address from DHCP (as access
            // points have) changing later does not matter.
            DirectInterface: main,
            BannerFile: "/etc/banner",
          }),
        ],
      },
      uhttpd: {
        uhttpd: [
          section(
            {
              name: "main",
              // Not on the WAN side.
              overrides: [{ when: onRouter, options: { listen_http: [`${router}:80`], listen_https: [`${router}:443`] } }],
            },
            {
              listen_http: ["0.0.0.0:80", "[::]:80"],
              listen_https: ["0.0.0.0:443", "[::]:443"],
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
            }
          ),
        ],
        cert: [
          section(
            { name: "defaults" },
            { days: 397, key_type: "ec", ec_curve: "P-256", country: intent.system.country, commonname: "OpenWrt" }
          ),
        ],
      },
      attendedsysupgrade: { client: [section({ name: "client" }, {})] },
    },
  };
};
