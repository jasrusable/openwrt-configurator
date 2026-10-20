// The site, and who logs in to its devices.
import { z } from "zod";
import { firmwareRelease } from "../validators";
import { countries } from "./countries";
import { timezones } from "./timezones";

/** One SSH public key line: "ssh-ed25519 AAAA… comment". */
export const sshPublicKey = z
  .string()
  .trim()
  .regex(
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\n]*)?$/,
    "an SSH public key, like ssh-ed25519 AAAA… you@computer"
  );

export const systemSchema = z
  .object({
    name: z.string().min(1, "required"),
    /**
     * What the site's derived ids grow from (the ULA prefix, the mesh id,
     * the UPnP UUID, remote clients' IPv6): its first name, kept when it
     * is renamed (`keepSiteSeed`), so a rename re-keys none of them.
     * Unset, the name.
     */
    site_id: z.string().min(1).optional(),
    timezone: z
      .string()
      .refine((zone) => zone in timezones, "an IANA zone, like Europe/Zurich"),
    /** Wi-Fi regulatory domain, ISO 3166 (CH, US, ...). */
    country: z
      .string()
      .refine((code) => countries.includes(code), "pick a country"),
    /** How this app logs in to the devices, as root. */
    app_login: z
      .object({
        /** The private key on this computer, or a public key whose private half the agent holds (1Password); else the agent's. */
        key: z.string().optional(),
        /**
         * Also set as root's password on every device (system/compile.ts).
         * Required (system/checks.ts): left optional here so a file without
         * one still reads, its issue shown at this field.
         */
        password: z
          .string()
          .max(128, "at most 128 characters")
          .refine((p) => !/[\r\n]/.test(p), "one line")
          .optional(),
      })
      .strict()
      .default({}),
    /**
     * Who may log in as root over SSH: the compiler installs
     * authorized_keys and can turn password login off. Root's password
     * (app_login.password, required) is what closes a device fresh from
     * stock, which lets root in with any password, web logins included.
     */
    ssh: z
      .object({
        /** Public keys allowed to log in as root, as `ssh-keygen` writes them. */
        authorized_keys: z.array(sshPublicKey).default([]),
        /** Whether root may log in with a password; off needs an authorized key. */
        password_login: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /**
     * Fixes over OpenWrt (src/intent/patches) turned off, by id: a decision
     * like any other. Required ones cannot be (patches' own check).
     */
    patches: z
      .object({ off: z.array(z.string()).default([]) })
      .strict()
      .default({}),
    /**
     * Which OpenWrt the devices run (System › Firmware): "stable" (the
     * newest stable release of any series: it moves to the next series once
     * that is out), a series ("25.12": its newest release, never the next
     * series's) or one release ("25.12.5"). Unset, the oldest series this
     * app supports. A device can hold or pin its own (hardware.*.firmware).
     */
    firmware: z
      .object({
        release: z
          .union([
            z.literal("stable"),
            firmwareRelease(/^\d+\.\d+(\.\d+)?$/, "stable, a series like 25.12, or a release like 25.12.5"),
          ])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
