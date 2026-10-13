// What a client probably is, for its icon on Status › Clients: from what it
// says of itself over mDNS (its model, its services) first, then its name,
// then who made its network card. A guess, shown as an icon only.

export const clientKinds = ["phone", "tablet", "watch", "laptop", "computer", "tv", "speaker", "printer", "camera", "console", "iot"] as const;
export type ClientKind = (typeof clientKinds)[number];

/** Apple's model identifiers (device-info), Cast models (`md`): what each family is. */
const byModel: [RegExp, ClientKind][] = [
  [/^iphone/i, "phone"],
  [/^ipad/i, "tablet"],
  [/^watch/i, "watch"],
  [/^macbook/i, "laptop"],
  [/^(mac|imac|macmini|macpro)/i, "computer"],
  [/^appletv/i, "tv"],
  [/^audioaccessory|homepod|nest (mini|audio)|google home|speaker/i, "speaker"],
  [/chromecast|google tv|\btv\b/i, "tv"],
];

/** Services only one kind of device offers. */
const byService: [RegExp, ClientKind][] = [
  [/^_(ipp|ipps|printer|pdl-datastream)\._tcp$/, "printer"],
  [/^_sonos\._tcp$|^_spotify-connect\._tcp$/, "speaker"],
  [/^_googlecast\._tcp$/, "tv"],
  [/^_(hap|homekit)\._(tcp|udp)$/, "iot"],
];

/** From the name a device gives (DHCP, mDNS). */
const byName: [RegExp, ClientKind][] = [
  [/iphone|pixel|galaxy|android|phone|oneplus|xiaomi|redmi|huawei|oppo|motorola/i, "phone"],
  [/ipad|tablet|kindle|\btab\b|-tab/i, "tablet"],
  [/watch/i, "watch"],
  [/macbook|laptop|thinkpad|surface|notebook|xps|zenbook/i, "laptop"],
  [/^mac$|imac|desktop|\bpc\b|-pc|workstation|mac-?mini|mac-?studio|nas|synology|server|raspberry|\brpi/i, "computer"],
  [/\btv\b|-tv|appletv|apple-tv|chromecast|roku|firetv|fire-tv|shield|bravia|webos|tizen/i, "tv"],
  [/sonos|echo|homepod|speaker|beoplay|bose|marshall|nest-?(audio|mini)|google-?home/i, "speaker"],
  // Brother printers name themselves BRW/BRN and their MAC.
  [/printer|epson|^br[wn][0-9a-f]{6}|canon|hp[a-f0-9]{6}|laserjet|officejet/i, "printer"],
  [/cam|ring|doorbell|arlo|wyze/i, "camera"],
  [/playstation|ps[45]|xbox|switch|steam/i, "console"],
  [/esp|tasmota|shelly|tuya|hue|wiz_|bulb|plug|light|lifx|tado|sensor|thermostat|roborock|vacuum|purifier|levoit|litter|robot|dyson/i, "iot"],
];

/**
 * A few makers whose cards say what the device is (the first three bytes of
 * the MAC). Small on purpose: phones and laptops come from makers of
 * everything, and send private addresses besides.
 */
const byMaker: [string[], ClientKind][] = [
  // Espressif: the chip in most smart plugs, bulbs and sensors.
  [["24:0a:c4", "24:62:ab", "30:ae:a4", "3c:71:bf", "84:cc:a8", "a4:cf:12", "bc:dd:c2", "cc:50:e3", "dc:4f:22", "ec:fa:bc"], "iot"],
  // Philips Hue (Signify).
  [["00:17:88"], "iot"],
  // Raspberry Pi.
  [["b8:27:eb", "dc:a6:32", "e4:5f:01"], "computer"],
  // Sonos.
  [["00:0e:58"], "speaker"],
  // Roku.
  [["b0:a7:37", "d8:31:34", "cc:6d:a0"], "tv"],
  // Nintendo; Sony Interactive (PlayStation).
  [["98:b6:e9", "00:d9:d1", "70:9e:29"], "console"],
];

/** A MAC its device made up (a phone's private address): no maker to read. */
const isPrivate = (mac: string) => (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0;

const first = (rules: [RegExp, ClientKind][], value: string | undefined) =>
  value === undefined ? undefined : rules.find(([re]) => re.test(value))?.[1];

export const clientKind = ({
  mac,
  name,
  model,
  services = [],
}: {
  mac: string;
  name?: string;
  model?: string;
  services?: string[];
}): ClientKind | undefined =>
  first(byModel, model) ??
  services.map((s) => first(byService, s)).find(Boolean) ??
  first(byName, name) ??
  (isPrivate(mac) ? undefined : byMaker.find(([prefixes]) => prefixes.includes(mac.slice(0, 8).toLowerCase()))?.[1]);
