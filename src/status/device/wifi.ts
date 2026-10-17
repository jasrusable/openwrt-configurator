// Wi-Fi: each hostapd interface with its clients, and usteer's view of
// which access points hear each client (roaming).
import type { Probe } from "../../deviceProbes";
import { arr, num, obj, str } from "../values";
import { eachHostapd, json } from "./common";
import type { WifiInterface } from "./types";

/** The Wi-Fi probe's array: each hostapd interface's get_status and get_clients. */
export const parseWifi = (list: unknown): WifiInterface[] =>
  arr(list)
    .map(obj)
    .map((entry) => {
      const status = obj(entry.status);
      const clients = obj(obj(entry.clients).clients);
      return {
        ifname: (str(entry.object) ?? "").replace(/^hostapd\./, ""),
        ...(str(status.ssid) ? { ssid: str(status.ssid) } : {}),
        ...(num(status.freq) !== undefined ? { freq: num(status.freq) } : {}),
        ...(num(status.channel) !== undefined ? { channel: num(status.channel) } : {}),
        ...(() => {
          const info = obj(entry.info);
          return {
            ...(str(info.htmode) ? { htmode: str(info.htmode) } : {}),
            ...(num(info.txpower) !== undefined ? { txpower: num(info.txpower) } : {}),
            ...(num(info.noise) !== undefined && num(info.noise) !== 0 ? { noise: num(info.noise) } : {}),
          };
        })(),
        clients: Object.entries(clients).map(([mac, client]) => {
          const c = obj(client);
          const bytes = obj(c.bytes);
          return {
            mac: mac.toLowerCase(),
            ...(num(c.signal) !== undefined ? { signal: num(c.signal) } : {}),
            ...(num(bytes.rx) !== undefined ? { rxBytes: num(bytes.rx) } : {}),
            ...(num(bytes.tx) !== undefined ? { txBytes: num(bytes.tx) } : {}),
            ...(num(c.connected_time) !== undefined ? { connected: num(c.connected_time) } : {}),
          };
        }),
      };
    });

// An access point's hostapd interfaces with their status, clients and
// iwinfo's view; a call that fails, or says nothing, gives null.
export const wifi: Probe<unknown> = {
  command: eachHostapd([
    `printf '"object":"%s","status":' "$o"; call "$o" get_status`,
    `printf ',"clients":'; call "$o" get_clients`,
    `printf ',"info":'; call iwinfo info "{\\"device\\":\\"$d\\"}"`,
  ]),
  parse: ({ stdout }) => json(stdout, "hostapd"),
};

/** `ubus call usteer get_clients`: per client, per node (this one's or another's), connected and signal. */
export const parseHeardBy = (value: unknown) =>
  Object.entries(obj(value)).flatMap(([mac, nodes]) =>
    Object.entries(obj(nodes)).map(([node, info]) => {
      const i = obj(info);
      return {
        mac: mac.toLowerCase(),
        node,
        ...(num(i.signal) !== undefined ? { signal: num(i.signal) } : {}),
        connected: i.connected === true,
      };
    })
  );

export const heardBy: Probe<unknown> = {
  command: "ubus call usteer get_clients 2>/dev/null || echo '{}'",
  parse: ({ stdout }) => json(stdout || "{}", "usteer get_clients"),
};
