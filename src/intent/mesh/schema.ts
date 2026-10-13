// Wireless backhaul: access points (and the router, with a radio) link to
// each other over Wi-Fi (802.11s, with batman-adv routing over it), so an
// access point needs no cable. Every node uses one band and channel.
import { z } from "zod";
import { meshBands } from "../radios";
import { wifiPassword } from "../validators";

export const meshSchema = z
  .object({
    enabled: z.boolean().default(false),
    band: z.enum(meshBands).default("5g"),
    /** Fixed: every node must be on it. Never a radar (DFS) channel, which a radar would move. */
    channel: z.number().int().default(36),
    /** Generated when the mesh is turned on; every node must have the same. */
    key: wifiPassword.optional(),
    /** The band is the mesh's alone: no SSID uses it (a tri-band access point's 6 GHz, say). */
    band_reserved: z.boolean().default(false),
    /** batman also over the cables between nodes, on a VLAN of its own: a cable when there is one, Wi-Fi when not. */
    over_cable: z.boolean().default(false),
    /** Over cables, batman's whole 1532-byte frames: every switch between nodes must pass them. Off, it splits its packets there. */
    large_frames: z.boolean().default(true),
  })
  .strict()
  .default({});
