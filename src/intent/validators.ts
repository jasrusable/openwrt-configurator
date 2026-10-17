// Values several settings share the rules of: names, addresses, Wi-Fi
// passwords, firmware releases. A rule only one feature uses lives in that feature's schema.
import { z } from "zod";
import { isIpAddress, parseIpv4 } from "./addresses";
import { supportedRelease } from "../release";

/** A device's or network's name: a hostname's rules. */
export const namePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const name = z.string().regex(namePattern, "lowercase letters, digits and -, like a hostname");

export const wifiPassword = z
  .string()
  .min(8, "at least 8 characters")
  .max(63, "at most 63 characters");

/** A private IPv4 /24 (RFC 1918), like 10.0.0.0/24, as "a.b.c.0/24": its first three parts. */
export const parseSubnet = (subnet: string) => {
  const [address, length] = subnet.split("/");
  if (length !== "24" || parseIpv4(address) === undefined || !address.endsWith(".0")) return undefined;
  const [a, b, c] = address.split(".").map(Number);
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return isPrivate ? [a, b, c] : undefined;
};

export const ipv4Subnet = z
  .string()
  .refine(
    (subnet) => parseSubnet(subnet) !== undefined,
    "a private range: 10.x.x.0/24, 172.16-31.x.0/24 or 192.168.x.0/24"
  );

export const ipv4 = z
  .string()
  .refine((a) => parseIpv4(a) !== undefined, "an IPv4 address, like 203.0.113.10");

/** A DNS server: IPv4 or IPv6. */
export const dnsServer = z.string().refine(isIpAddress, "an IP address, like 9.9.9.9");

/** An OpenWrt release the devices may be moved to, as `pattern` allows: 25.12 or later (apk). */
export const firmwareRelease = (pattern: RegExp, example: string) =>
  z.string().regex(pattern, example).refine(supportedRelease, "25.12 or later: this app installs packages with apk");
