// The networks: one untagged main network, and any number on their own
// VLANs (guests, IoT). Every LAN port and access point carries them all.
import { z } from "zod";
import { networkAccessSchema, reservedIds, vpnZoneIds } from "../access";
import { ipv4, ipv4Subnet, name } from "../validators";

/** A DHCP lease: a whole number of minutes (at least 2), hours or days. */
const leaseTime = z
  .string()
  .regex(/^\d+[mhd]$/, "like 12h, 30m or 7d")
  .refine(
    (lease) => parseInt(lease, 10) >= (lease.endsWith("m") ? 2 : 1),
    "at least 2 minutes"
  );

/** A MAC address, as aa:bb:cc:dd:ee:ff. */
export const macAddress = z
  .string()
  .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, "like aa:bb:cc:dd:ee:ff");

/** A device that always gets the same address, and a name in DNS. */
const reservation = z
  .object({
    /** Also its DNS name: name.<local domain>. */
    name,
    mac: macAddress,
    address: z.string(),
  })
  .strict();

/**
 * The names the compiler gives sections of its own: a network named so would
 * share a section with one (the engine refuses two of one name), so refused here.
 */
const fixedSectionNames = [
  ...vpnZoneIds, "loopback", "globals", "bat0", "batmesh", "batwired", "rescue", "odhcpd", "mesh", "mesh0", "meshport",
  "meshwired", "client", "config", "default", "defaults", "global", "https", "main", "nlbwmon", "ntp", "usteer",
];

/** The names the engine gives a section the compiler leaves unnamed: its type and its place (dnsmasq0, device1). */
const engineSectionName =
  /^(device|interface|switch|dnsmasq|dhcp|odhcpd|host|domain|defaults|zone|forwarding|rule|redirect|route|system|timeserver|wifidevice|wifinet|wifistation|radio)\d+$/;

export const networkSchema = z
  .object({
    /**
     * Stable and hidden: Wi-Fi refers to it, and it names the network on the
     * devices, so renaming never breaks a link. Short, as UCI names must be.
     */
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]{0,9}$/, "a short id")
      // Not "wan…", "tun…", "vpn" or "sites": the internet connections' and
      // the VPN's interfaces are named so.
      .refine(
        (id) =>
          !reservedIds.includes(id) && !/^(wan|tun\d)/.test(id) && !fixedSectionNames.includes(id) && !engineSectionName.test(id),
        "reserved"
      ),
    name: z.string().min(1, "required").max(32),

    /** Absent for the main network, which is untagged on every port. */
    vlan: z
      .number()
      .int()
      .min(2, "2 to 4094 (1 is the main network)")
      .max(4094, "2 to 4094")
      .optional(),
    subnet: ipv4Subnet,
    ipv6: z.boolean().default(true),
    dhcp: z
      .object({
        /** How many addresses it hands out (the pool ends at .254). */
        pool_size: z.number().int().min(1).max(253).default(150),
        lease: leaseTime.default("12h"),
        /** DNS servers handed to devices instead of the router (a Pi-hole, say). */
        dns_servers: z.array(ipv4).min(1, "at least one").optional(),
        /** Devices that always get the same address, and a name in DNS. */
        reservations: z.array(reservation).default([]),
      })
      .strict()
      .default({}),
    access: networkAccessSchema.default({}),
    /**
     * Devices on it (AirPlay, printers, Chromecast) are seen on the other
     * networks that share theirs, and theirs here: mDNS, reflected.
     */
    share_devices: z.boolean().default(false),
  })
  .strict();

export const networksSchema = z.array(networkSchema).min(1, "at least one network");
