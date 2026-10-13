// Wi-Fi: its networks (SSIDs), the radios, roaming between access points,
// and the mesh (mesh/, under wifi in the file), which shares their radios.
import { z } from "zod";
import { bands, channelWidths } from "../radios";
import { wifiPassword } from "../validators";
import { steeringLevels } from "./roaming";

export const securityModes = ["wpa2", "wpa2-wpa3", "wpa3"] as const;

/** One SSID, on every access point. */
const ssidSchema = z
  .object({
    ssid: z.string().min(1, "required").max(32, "at most 32 characters"),
    /** Off: kept, but not broadcast. */
    enabled: z.boolean().default(true),
    /** The id of the network it joins. */
    network: z.string().min(1, "pick a network"),
    /** Where it is broadcast; unset, on every enabled band. */
    bands: z.array(z.enum(bands)).min(1, "at least one band").optional(),
    /**
     * Clients cannot reach each other: hostapd's isolation, within one
     * access point and band.
     */
    isolate_clients: z.boolean().default(false),
    /** WPA2; WPA2 and WPA3 side by side; or WPA3 only. 6 GHz is always WPA3. */
    security: z.enum(securityModes).default("wpa2"),
    password: wifiPassword,
    /** More passwords for the same network, e.g. one per person (WPA2 only). */
    extra_passwords: z.array(wifiPassword).optional(),
    /** Not announced: devices must be told its name. */
    hidden: z.boolean().default(false),
    roaming: z
      .object({
        /** 802.11r: devices move between access points without a pause. */
        fast: z.boolean().default(true),
        /** 802.11k/v: access points tell devices their neighbours, so they roam well. */
        assisted: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict();

/** One band's radios, on every access point. */
const radio = (defaults: { enabled: boolean }) =>
  z
    .object({
      enabled: z.boolean().default(defaults.enabled),
      /** MHz; "auto" picks the band's usual width. */
      width: z.enum(channelWidths).default("auto"),
      /** Transmit power. Auto is the most the country allows. */
      power: z.enum(["auto", "low", "medium", "high"]).default("auto"),
      /** Fewer, faster clients near each access point; less range. */
      cell_density: z.enum(["off", "normal", "high", "very_high"]).default("normal"),
      /**
       * What the radio's queues favour: little queued for snappy calls and
       * games (latency), the kernel's own (balanced), or more queued to fill
       * the air (throughput). Per radio: every SSID on it shares its queues.
       */
      airtime: z.enum(["balanced", "latency", "throughput"]).default("balanced"),
      /**
       * 5 GHz: an automatic channel never on one with radar detection (DFS),
       * whose radios wait 60 s (10 min on weather channels) before each start.
       */
      avoid_radar: z.boolean().default(false),
    })
    .strict()
    .default({});

/** Per band, on every access point. */
const radiosSchema = z
  .object({
    "2g": radio({ enabled: true }),
    "5g": radio({ enabled: true }),
    // Off by default: few access points have it, and it needs WPA3.
    "6g": radio({ enabled: false }),
  })
  .strict()
  .default({});

/**
 * How the access points move devices to a better access point or band
 * (usteer), on the SSIDs with roaming assistance. Off gives no neighbour
 * lists at all; advise only gives them; nudge asks a fading device to
 * move; push also disconnects one that will not, or that stays too weak.
 * The values per level are in wifi/roaming.ts.
 */
const roamingSchema = z
  .object({
    steering: z.enum(steeringLevels).default("advise"),
    /** Ask dual-band devices with a strong signal to leave 2.4 GHz. */
    prefer_5g: z.boolean().default(false),
  })
  .strict()
  .default({});

/** Wi-Fi's own settings; the root schema adds the mesh's (mesh/schema.ts), which lives under them. */
export const wifiSchema = z
  .object({
    networks: z.array(ssidSchema),
    radios: radiosSchema,
    roaming: roamingSchema,
  })
  .strict();
