// A device's radios, fitted: each declared wifi-device to the radios of
// its band the device has (by path or phy, its mode the best it supports up
// to a width), each Wi-Fi interface onto those radios, and a wifi-station
// per extra password; radios nothing declares or uses are off.
import { bestMode } from "./radioModes";
import { DeviceSchema } from "../deviceSchema";
import { OpenWrtSection } from "./openWrtState";
import { isPlaceholder, Scalar, Value } from "../plan/types";
import { ResolvedSection } from "./resolvePlan";
import { sanitizeName, strings, writeSection } from "./values";

// A channel of each band (6 GHz: its first preferred-scan channel; 60 GHz: 802.11ad's 2).
const defaultChannels = {
  "2g": 11,
  "5g": 36,
  "6g": 37,
  "60g": 2,
};

/** The wireless config for a device's radios, or none where it has none. */
export const fitRadios = ({
  hostname,
  deviceSchema,
  wireless,
}: {
  hostname: string;
  deviceSchema: DeviceSchema;
  wireless: Record<string, ResolvedSection[]> | undefined;
}): Record<string, OpenWrtSection[]> | undefined => {
  const written = writeSection(hostname);
  // Each radio with its band's declared wifi-device: the first of a band by
  // that section's name, another (tri-band: two in 5 GHz) by the name and
  // its place, or uci would merge the two.
  const declaredRadios = wireless?.["wifi-device"] || [];
  const radios = (deviceSchema.radios || []).reduce<
    { radio: NonNullable<DeviceSchema["radios"]>[number]; declared?: ResolvedSection; name: string; first: boolean }[]
  >((acc, radio, index) => {
    const declared = declaredRadios.find((d) => d.options.band === radio.band);
    const wanted = sanitizeName(declared?.name || `wifidevice${index}`);
    const first = !acc.some((r) => r.name === wanted);
    return [...acc, { radio, declared, name: first ? wanted : sanitizeName(`${wanted}${index}`), first }];
  }, []);
  const radioNames = radios.map((r) => r.name);

  // A declared radio's name stands for every radio of its band; an interface
  // with a name of its own (the mesh's ifname) is one device, so on the first
  // only. A radio declared for a band this device lacks (6 GHz on a dual-band
  // access point) has none here, so an interface on it is skipped. A name
  // nothing declares goes through, for netifd to report, rather than hiding
  // a typo.
  const radiosNamed = (name: string, single: boolean) => {
    const ofBand = radios.filter((r) => r.declared?.name === name).map((r) => r.name);
    return ofBand.length > 0
      ? ofBand.slice(0, single ? 1 : undefined)
      : radioNames.includes(name) || !declaredRadios.some((d) => d.name === name)
        ? [name]
        : [];
  };

  const ifaces = (wireless?.["wifi-iface"] || []).map((iface, wifiIfaceIndex) => {
    const { device, stations, ...options } = iface.options;
    // Unset, or every radio: each one the device has.
    const named = device === undefined || (isPlaceholder(device) && device.kind === "allRadios") ? undefined : strings(device);
    const devices = named ? named.flatMap((name) => radiosNamed(name, !!options.ifname)) : radioNames;
    const base = iface.name;
    const interfaces = devices.map((deviceName, deviceIndex) => ({
      // A named interface is one per radio: the radio's name is added.
      name: base ? `${base}_${sanitizeName(deviceName)}` : `wifinet${wifiIfaceIndex}${deviceIndex}`,
      options: { device: deviceName, ...options } as Record<string, Value>,
    }));
    const keys = isPlaceholder(stations) && stations.kind === "stations" ? stations.keys : [];
    // Any-MAC wildcard so hostapd accepts the PSK from every client.
    // iface must be set: an empty wifi-station.iface matches every SSID.
    const stationSections = interfaces.flatMap((i, deviceIndex) =>
      keys.map((key, stationIndex) => ({
        name: base ? `${i.name}_key${stationIndex}` : `wifistation${wifiIfaceIndex}${deviceIndex}${stationIndex}`,
        options: { iface: i.name, key, mac: "00:00:00:00:00:00" } as Record<string, Value>,
      }))
    );
    return { interfaces, stationSections };
  });
  const wifiInterfaces = ifaces.flatMap((i) => i.interfaces);
  const wifiStations = ifaces.flatMap((i) => i.stationSections);

  const wifiDevices = radios.map(({ radio, declared, name, first }) => {
    const htmode = declared?.options.htmode;
    const mode =
      isPlaceholder(htmode) && htmode.kind === "bestMode" ? bestMode(htmode.width, radio.htmodes) : (htmode as Scalar | undefined);
    return written("wireless", "wifi-device", name, {
      ...declared?.options,
      // A pinned channel (or the mesh's) is the first radio's of its band:
      // another there (tri-band's upper 5 GHz) may not have it.
      channel: first ? (declared?.options.channel as Scalar | undefined) || defaultChannels[radio.band] : "auto",
      type: radio.type,
      band: radio.band,
      ...(radio.path ? { path: radio.path } : radio.phy !== undefined ? { phy: radio.phy } : {}),
      ...(radio.radio !== undefined ? { radio: radio.radio } : {}),
      // None fits: unset, OpenWrt's default.
      htmode: mode,
      // Nothing declares it or uses it: off, rather than up with no country.
      ...(!declared && !wifiInterfaces.some((i) => i.options.device === name) ? { disabled: true } : {}),
    });
  });

  if (radios.length === 0) return undefined;
  return {
    "wifi-device": wifiDevices,
    "wifi-iface": wifiInterfaces.map((i) => written("wireless", "wifi-iface", i.name, i.options)),
    ...(wifiStations.length > 0 && {
      "wifi-station": wifiStations.map((s) => written("wireless", "wifi-station", s.name, s.options)),
    }),
  };
};
