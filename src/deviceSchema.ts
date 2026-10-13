import { z } from "zod";
import { wifiBands, wifiTypes } from "./openWrtValues";

export const deviceSchemaSchema = z.object({
  name: z.string(),
  /** The model for people, from board.json (e.g. "FriendlyElec NanoPi R6S"); name is its id. */
  model: z.string().optional(),
  sw_config: z.boolean().optional(),
  /** swconfig: the switch's name, as board.json gives it (switch0, switch1…). */
  switch: z.string().optional(),
  version: z.string(),
  /** OpenWrt's target/subtarget (mediatek/filogic, rockchip/armv8): what drivers and kernel quirks it shares with others. */
  target: z.string().optional(),
  ports: z
    .array(
      z.object({
        name: z.string(),
        default_role: z.enum(["lan", "wan"]).optional(),
        sw_config_cpu_name: z.string().optional(),
        /** swconfig: its number on the switch; absent for a port beside the switch (a NIC of its own). */
        switch_port: z.number().int().optional(),
      })
    )
    .optional(),
  radios: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(wifiTypes),
        /** How OpenWrt finds it: by path, or by phy when the phy has its own name. */
        path: z.string().optional(),
        phy: z.string().optional(),
        /** Which radio of a wiphy several share. */
        radio: z.number().optional(),
        band: z.enum(wifiBands),
        /** The modes it supports, as board.json lists them (HE80, VHT160, …). */
        htmodes: z.array(z.string()).optional(),
        max_width: z.number().optional(),
        /** Whether it can be a mesh point (802.11s); unknown when not read. */
        mesh: z.boolean().optional(),
        /** The channels it can use in its band (nl80211's, less those disabled); unknown when not read. */
        channels: z.array(z.number().int()).optional(),
      })
    )
    .optional(),
  /** What the device has but this app could not use, in words. */
  skipped: z.array(z.string()).optional(),
});

export type DeviceSchema = z.infer<typeof deviceSchemaSchema>;
