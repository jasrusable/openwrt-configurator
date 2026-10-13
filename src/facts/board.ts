// What a device is, from what OpenWrt itself says about the hardware: the
// model and release from `ubus call system board`, ports and switch from
// /etc/board.json, radios from board.json's `wlan` (written by OpenWrt's
// wifi-detect from the hardware, and what its own wireless setup reads), the
// UCI wireless config only where a device has no `wlan`. Pure, and tolerant:
// board.json differs across targets and releases, so every field is
// optional, any name is taken as given, and what cannot be used is skipped
// and said, never a failure of the whole device. Only no ports at all fails.
import { DeviceSchema } from "../deviceSchema";
import { wifiBands } from "../openWrtValues";

type Json = Record<string, any>;
type Port = NonNullable<DeviceSchema["ports"]>[number];
type Radio = NonNullable<DeviceSchema["radios"]>[number];

const object = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Older switches (swconfig): each switch board.json lists, by its name (switch0, …). */
const switchesOf = (board: Json) => Object.entries(object(board.switch)).filter(([, s]) => Array.isArray(object(s).ports));

/**
 * The (first) switch's ports by number, named `port<num>` (not eth<num>, a
 * real NIC's name on boards with one beside the switch).
 */
const switchPorts = (board: Json): Port[] | undefined => {
  const switches = switchesOf(board).map(([, s]) => s);
  if (switches.length === 0) return undefined;
  return (object(switches[0]).ports as unknown[]).flatMap((p): Port[] => {
    const port = object(p);
    if (typeof port.num !== "number") return [];
    const role = port.role === "lan" || port.role === "wan" ? port.role : undefined;
    return [
      {
        name: `port${port.num}`,
        switch_port: port.num,
        ...(role ? { default_role: role } : {}),
        ...(string(port.device) ? { sw_config_cpu_name: port.device } : {}),
      },
    ];
  });
};

/** DSA or plain interfaces: each network's ports, or its one device, by whatever name. */
const networkPorts = (board: Json): Port[] => {
  const network = object(board.network);
  return (["lan", "wan"] as const).flatMap((role) => {
    const net = object(network[role]);
    const ports = strings(net.ports);
    const names = ports.length ? ports : string(net.device) ? [net.device as string] : [];
    return names.map((name) => ({ name, default_role: role }));
  });
};

/** On a switch board, a network on a NIC of its own (ath79's WAN on eth0, the LAN on the switch's eth1): a port as on DSA. */
const portsBesideSwitch = (board: Json, onSwitch: Port[]): Port[] => {
  const cpus = onSwitch.flatMap((p) => (p.sw_config_cpu_name ? [p.sw_config_cpu_name] : []));
  return networkPorts(board).filter((p) => !cpus.includes(p.name.replace(/\.\d+$/, "")));
};

const bandOrder = ["60G", "6G", "5G", "2G"];

/**
 * Radios as OpenWrt's own wireless setup (mac80211.uc) finds them: one per
 * radio of a wiphy (several share one on newer hardware, told apart by
 * `radio`), in its highest band, by path, or by phy when the phy has its own
 * name. With the modes it supports, so a mode is chosen that it can run.
 */
const wlanRadios = (board: Json, skipped: string[]): Radio[] | undefined => {
  const wlan = Object.entries(object(board.wlan)).filter(([name]) => name !== "defaults");
  if (wlan.length === 0) return undefined;
  return wlan.flatMap(([phyName, value]) => {
    const phy = object(value);
    const info = object(phy.info);
    const bands = object(info.bands);
    const multi = Array.isArray(info.radios) && info.radios.length > 0;
    const radios: Json[] = multi ? info.radios.map(object) : [{ bands }];
    return radios.flatMap((radio): Radio[] => {
      const label = multi ? `${phyName} radio ${radio.index}` : phyName;
      const bandName = bandOrder.find((b) => object(radio.bands)[b]);
      const band = bandName?.toLowerCase() as Radio["band"] | undefined;
      if (!bandName || !band || !(wifiBands as readonly string[]).includes(band)) {
        skipped.push(`${label}: no band this app supports`);
        return [];
      }
      const path = string(phy.path);
      const byPhy = !/^phy[0-9]/.test(phyName);
      if (!path && !byPhy) {
        skipped.push(`${label}: no path`);
        return [];
      }
      const caps = object(bands[bandName]);
      return [
        {
          name: phyName,
          type: "mac80211",
          ...(byPhy ? { phy: phyName } : { path }),
          ...(multi && typeof radio.index === "number" ? { radio: radio.index } : {}),
          band,
          ...(strings(caps.modes).length ? { htmodes: strings(caps.modes) } : {}),
          ...(typeof caps.max_width === "number" ? { max_width: caps.max_width } : {}),
        } as Radio,
      ];
    });
  });
};

/** A frequency's channel and band, as OpenWrt's wifi-detect counts them (MHz). */
const channelOf = (freq: number): { band: Radio["band"]; channel: number } | undefined =>
  freq === 2484
    ? { band: "2g", channel: 14 }
    : freq >= 2407 && freq < 2484
      ? { band: "2g", channel: (freq - 2407) / 5 }
      : freq === 5935
        ? { band: "6g", channel: 2 }
        : freq >= 5000 && freq < 5950
          ? { band: "5g", channel: (freq - 5000) / 5 }
          : freq >= 5950 && freq <= 7125
            ? { band: "6g", channel: (freq - 5950) / 5 }
            : undefined;

/**
 * A radio's channels: its wiphy's enabled frequencies (wiphyChannels in
 * getDeviceSchema.ts) in its band, and, where a wiphy has several radios,
 * within that radio's own ranges (kHz, as nl80211 gives them).
 */
const channelsOf = (wiphys: Json, radio: Radio): number[] | undefined => {
  const wiphy = object(wiphys[radio.phy ?? radio.name]);
  const freqs = Array.isArray(wiphy.freqs) ? wiphy.freqs.filter((f): f is number => typeof f === "number") : undefined;
  if (!freqs) return undefined;
  const own = (Array.isArray(wiphy.radios) ? wiphy.radios.map(object) : []).find((r) => r.index === radio.radio);
  const ranges = Array.isArray(own?.ranges) ? (own!.ranges as unknown[]).filter((r): r is [number, number] => Array.isArray(r)) : undefined;
  return freqs
    .filter((f) => !ranges || ranges.some(([start, end]) => f * 1000 >= start && f * 1000 <= end))
    .flatMap((f) => {
      const at = channelOf(f);
      return at && at.band === radio.band && Number.isInteger(at.channel) ? [at.channel] : [];
    });
};

/** A device without `wlan` (older releases): its wifi-device sections, as `ubus call uci get` gives them. */
const uciRadios = (uci: unknown, skipped: string[]): Radio[] =>
  Object.values(object(object(uci).values)).flatMap((value): Radio[] => {
    const s = object(value);
    if (s[".type"] !== "wifi-device") return [];
    const band = string(s.band);
    if (!band || !(wifiBands as readonly string[]).includes(band) || !(string(s.path) || string(s.phy))) {
      skipped.push(`${s[".name"] ?? "a radio"}: no band or path in the wireless config`);
      return [];
    }
    return [
      {
        name: String(s[".name"]),
        type: (string(s.type) ?? "mac80211") as Radio["type"],
        ...(string(s.path) ? { path: s.path } : { phy: s.phy }),
        ...(s.radio !== undefined && !isNaN(Number(s.radio)) ? { radio: Number(s.radio) } : {}),
        band: band as Radio["band"],
      },
    ];
  });

export const parseDeviceFacts = ({
  board: boardRaw,
  system: systemRaw,
  uciWireless,
  meshSupport,
  wiphys,
}: {
  /** /etc/board.json. */
  board: unknown;
  /** `ubus call system board`. */
  system: unknown;
  /** `ubus call uci get` for wireless wifi-devices: only used without board.json's `wlan`. */
  uciWireless?: unknown;
  /** Which wiphys can be a mesh point, by name (deviceProbes' meshSupport); unknown where absent. */
  meshSupport?: unknown;
  /** Each wiphy's enabled frequencies and its radios' ranges, by name (wiphyChannels); unknown where absent. */
  wiphys?: unknown;
}): DeviceSchema => {
  const board = object(boardRaw);
  const system = object(systemRaw);
  const skipped: string[] = [];
  const name = string(system.board_name) ?? string(object(board.model).id);
  const version = string(object(system.release).version);
  if (!name) throw new Error("The device names no board (ubus system board, board.json).");
  if (!version) throw new Error(`${name} reports no OpenWrt release (ubus system board).`);

  const fromSwitch = switchPorts(board);
  const switches = switchesOf(board).map(([switchName]) => switchName);
  // One switch is used; a second (rare) is said, not guessed at.
  switches.slice(1).forEach((other) => skipped.push(`${other}: a second switch (only ${switches[0]} is used)`));
  const ports = fromSwitch ? [...fromSwitch, ...portsBesideSwitch(board, fromSwitch)] : networkPorts(board);
  if (ports.length === 0) {
    throw new Error(
      `${name}: board.json lists no ports (network.lan and network.wan have neither ports nor a device, and there is no switch).`
    );
  }
  if (fromSwitch && !fromSwitch.some((p) => p.sw_config_cpu_name)) {
    throw new Error(`${name}: board.json's switch has no CPU port.`);
  }
  const mesh = object(meshSupport);
  const radios = (wlanRadios(board, skipped) ?? uciRadios(uciWireless, skipped)).map((radio) => {
    const channels = channelsOf(object(wiphys), radio);
    return {
      ...radio,
      ...(typeof mesh[radio.phy ?? radio.name] === "boolean" ? { mesh: mesh[radio.phy ?? radio.name] as boolean } : {}),
      ...(channels?.length ? { channels } : {}),
    };
  });
  const model = string(system.model) ?? string(object(board.model).name);
  const target = string(object(system.release).target);
  return {
    name,
    ...(model ? { model } : {}),
    version,
    ...(target ? { target } : {}),
    sw_config: !!fromSwitch,
    ...(fromSwitch ? { switch: switches[0] } : {}),
    ports,
    ...(radios.length ? { radios } : {}),
    ...(skipped.length ? { skipped } : {}),
  };
};
