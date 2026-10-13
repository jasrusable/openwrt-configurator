// The routers and access points: what each is called and does.
import { z } from "zod";
import { channelsOf } from "../radios";
import { firmwareRelease, name } from "../validators";

const channelHint = { "2g": "a 2.4 GHz channel, 1 to 13", "5g": "a 5 GHz channel, like 36 or 149" };

/** A radio's channel on a device: one of its band's, or "auto" (the default) to let it choose. */
const pinnedChannel = (band: keyof typeof channelsOf) =>
  z
    .object({
      channel: z
        .union([z.literal("auto"), z.number().refine((c) => channelsOf[band].includes(c), channelHint[band])])
        .optional(),
    })
    .strict()
    .optional();

export const deviceSchema = z
  .object({
    name,
    role: z.enum(["router", "access-point"]),
    /** Where it is, like "Living room": shown in LuCI. */
    location: z.string().max(64).optional(),
    /** How an access point reaches the network: a cable, or the mesh. */
    uplink: z.enum(["cable", "mesh"]).default("cable"),
    /** Its own radios: a channel pinned per band; "auto" (the default) lets it choose. */
    radios: z
      .object({ "2g": pinnedChannel("2g"), "5g": pinnedChannel("5g") })
      .strict()
      .optional(),
    /**
     * Its own firmware, over the network's (system.firmware): "hold" (never
     * upgraded) or one release pinned. Unset, it follows the network.
     */
    firmware: z.union([z.literal("hold"), firmwareRelease(/^\d+\.\d+\.\d+$/, "a release, like 25.12.5")]).optional(),
  })
  .strict();

export const hardwareSchema = z
  .array(deviceSchema)
  .refine(
    (devices) => devices.filter((d) => d.role === "router").length === 1,
    "exactly one device must be the router"
  )
  .refine(
    (devices) => new Set(devices.map((d) => d.name)).size === devices.length,
    "device names must be unique"
  );
