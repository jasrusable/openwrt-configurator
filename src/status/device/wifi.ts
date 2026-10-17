// Wi-Fi: each hostapd interface with its clients, and usteer's view of
// which access points hear each client (roaming). The link's rates and
// generation come from rpcd's iwinfo assoclist (every image here has it, by
// luci-ssl): hostapd's own `rate` in 25.12 is in tens of bits per second
// (its driver already turns nl80211's 100 kbit/s into kbit/s, and ubus.c
// multiplies by 100 again), and it has no EHT flag.
import type { Probe } from "../../deviceProbes";
import { arr, num, obj, str } from "../values";
import { json } from "./common";
import type { WifiInterface } from "./types";

/** The generation a link's rate says it uses: EHT is Wi-Fi 7, HE 6, VHT 5, HT 4. */
const generationOf = (rate: Record<string, unknown>) =>
  rate.eht === true ? 7 : rate.he === true ? 6 : rate.vht === true ? 5 : rate.ht === true ? 4 : undefined;

/** A rate in Mbit/s, from iwinfo's kbit/s. */
const mbps = (rate: Record<string, unknown>) => {
  const kbps = num(rate.rate);
  return kbps !== undefined && kbps > 0 ? Math.round(kbps / 100) / 10 : undefined;
};

/**
 * The channel's counters, from iwinfo's survey: the entry on the radio's
 * own frequency (rpcd says nothing of which is in use), as they are: a
 * counter mt76 wrapped (mt76#1135) still counts on, so the difference
 * between two reads can be right (history.ts, `airtimeOf`).
 */
const airtimeOf = (survey: unknown, freq: number | undefined) => {
  const own = arr(obj(survey).results)
    .map(obj)
    .find((s) => freq !== undefined && num(s.mhz) === freq);
  const active = num(own?.active_time);
  const busy = num(own?.busy_time);
  return active !== undefined && busy !== undefined && active > 0 && busy >= 0 ? { active, busy } : undefined;
};

/** The Wi-Fi probe's array: each hostapd interface's get_status and get_clients, iwinfo's info, assoclist and survey. */
export const parseWifi = (list: unknown): WifiInterface[] =>
  arr(list)
    .map(obj)
    .map((entry) => {
      const status = obj(entry.status);
      const clients = obj(obj(entry.clients).clients);
      const assoc = new Map(
        arr(obj(entry.assoc).results)
          .map(obj)
          .flatMap((a) => (str(a.mac) ? [[str(a.mac)!.toLowerCase(), a] as const] : []))
      );
      const airtime = airtimeOf(entry.survey, num(status.freq));
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
        ...(airtime ? { airtime } : {}),
        clients: Object.entries(clients).map(([mac, client]) => {
          const c = obj(client);
          const bytes = obj(c.bytes);
          const a = obj(assoc.get(mac.toLowerCase()));
          const [rx, tx] = [obj(a.rx), obj(a.tx)];
          // dBm is below zero: anything else is a field read wrongly, and the other source is asked.
          const signal = [num(c.signal), num(a.signal)].find((v) => v !== undefined && v < 0);
          const connected = num(c.connected_time) ?? num(a.connected_time);
          const [rxRate, txRate] = [mbps(rx), mbps(tx)];
          // Where iwinfo does not say, hostapd's flags: what the client and the access point both do.
          const generation = generationOf(tx) ?? generationOf(rx) ?? generationOf(c);
          return {
            mac: mac.toLowerCase(),
            ...(signal !== undefined ? { signal } : {}),
            ...(num(bytes.rx) !== undefined ? { rxBytes: num(bytes.rx) } : {}),
            ...(num(bytes.tx) !== undefined ? { txBytes: num(bytes.tx) } : {}),
            ...(connected !== undefined ? { connected } : {}),
            ...(rxRate !== undefined ? { rxRate } : {}),
            ...(txRate !== undefined ? { txRate } : {}),
            ...(generation !== undefined ? { generation } : {}),
          };
        }),
      };
    });

// One JSON array, built by the shell, so no output needs splitting: an
// access point's hostapd interfaces with their status and clients; none on a
// device without Wi-Fi. A call that fails, or says nothing, gives null: each
// is captured first, so one failing partway cannot leave half its JSON.
export const wifi: Probe<unknown> = {
  command: [
    'call() { r=$(ubus call "$@" 2>/dev/null) && [ -n "$r" ] && printf \'%s\' "$r" || printf null; }',
    "printf '['; sep=''",
    "for o in $(ubus list 'hostapd.*' 2>/dev/null); do",
    `  printf '%s{"object":"%s","status":' "$sep" "$o"; call "$o" get_status`,
    `  printf ',"clients":'; call "$o" get_clients`,
    `  printf ',"info":'; call iwinfo info "{\\"device\\":\\"\${o#hostapd.}\\"}"`,
    `  printf ',"assoc":'; call iwinfo assoclist "{\\"device\\":\\"\${o#hostapd.}\\"}"`,
    // Passive: the radio's counters as kept, no scan (a scan takes it off its channel).
    `  printf ',"survey":'; call iwinfo survey "{\\"device\\":\\"\${o#hostapd.}\\"}"`,
    "  printf '}'; sep=','",
    "done; printf ']'",
  ].join("\n"),
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
