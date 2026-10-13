// A provider's .ovpn is pasted from elsewhere and run by OpenVPN as root: a
// line that runs a program, loads a plugin, reads another config or writes a
// file there would run whatever the file's author chose. So a file may hold
// only the client options providers use (an allowlist: a denylist misses one,
// or a quoted spelling), each line read as OpenVPN reads it; anything else is
// refused, not edited, so the user sees why. ovpnFile also drops what is not
// allowed and ends with script-security 1, in case one slips past.
import { utf8ByteLength } from "../../utf8";

/** What a provider's client config may set. Routes and the device are the router's (vpn/compile.ts). */
const allowed = new Set([
  "client", "tls-client", "pull", "dev", "dev-type", "proto", "remote", "remote-random", "remote-random-hostname",
  "resolv-retry", "nobind", "float", "persist-key", "persist-tun", "persist-remote-ip", "persist-local-ip",
  "ca", "cert", "key", "pkcs12", "extra-certs", "tls-auth", "tls-crypt", "tls-crypt-v2", "key-direction",
  "cipher", "data-ciphers", "data-ciphers-fallback", "ncp-ciphers", "ncp-disable", "auth", "auth-user-pass",
  "auth-nocache", "auth-retry", "remote-cert-tls", "remote-cert-ku", "remote-cert-eku", "ns-cert-type",
  "verify-x509-name", "tls-version-min", "tls-version-max", "tls-cipher", "tls-ciphersuites", "tls-groups",
  "tls-cert-profile", "comp-lzo", "compress", "allow-compression", "verb", "mute", "mute-replay-warnings",
  "reneg-sec", "reneg-bytes", "reneg-pkts", "hand-window", "tran-window", "ping", "ping-restart", "ping-exit",
  "ping-timer-rem", "keepalive", "inactive", "connect-retry", "connect-retry-max", "connect-timeout",
  "server-poll-timeout", "explicit-exit-notify", "fast-io", "sndbuf", "rcvbuf", "txqueuelen", "tun-mtu",
  "tun-mtu-extra", "mssfix", "fragment", "link-mtu", "mtu-disc", "replay-window", "route-nopull",
  "redirect-gateway", "route", "route-ipv6", "route-delay", "pull-filter", "block-outside-dns", "dhcp-option",
  "push-peer-info", "port", "lport", "rport", "bind", "topology", "tun-ipv6", "user", "group", "x509-username-field",
  "peer-fingerprint", "machine-readable-output", "auth-token-user",
]);

/**
 * Options that read a file: only inline (a <ca> block, or "[inline]"). A
 * path would have OpenVPN read any file on the router, and auth-user-pass
 * send it to the provider as a login (/etc/shadow, say).
 */
const readsFile = new Set(["ca", "cert", "key", "pkcs12", "extra-certs", "tls-auth", "tls-crypt", "tls-crypt-v2", "auth-user-pass", "peer-fingerprint"]);

/** Inline blocks whose content is data (keys, certificates), not options. */
const dataBlocks = new Set(["ca", "cert", "key", "pkcs12", "extra-certs", "tls-auth", "tls-crypt", "tls-crypt-v2", "http-proxy-user-pass", "peer-fingerprint"]);

/** A line's words as OpenVPN reads them: quotes and backslash escapes undone; none for a comment. */
const words = (line: string): string[] => {
  const out: string[] = [];
  let word = "";
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!quote && !started && (c === "#" || c === ";")) break;
    if (c === "\\" && quote !== "'" && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (quote) {
      if (c === quote) quote = undefined;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
};

/** The option a line sets ("--up" is "up"; "setenv opt X" is X), lower-cased, and its arguments. */
const parsed = (line: string): { option?: string; args: string[] } => {
  let [first, ...rest] = words(line);
  if (first === undefined) return { args: [] };
  // "setenv opt <option>" still sets a known option: it is that option.
  if (first.replace(/^--/, "").toLowerCase() === "setenv" && rest[0]?.toLowerCase() === "opt") [, first, ...rest] = rest;
  return { option: (first ?? "").replace(/^--/, "").toLowerCase(), args: rest };
};

/** A line of a key or certificate: PEM armour, base64, hex, or a static key's comment. Nothing an option could be read from. */
const dataLine = (line: string) =>
  /^\s*$/.test(line) ||
  /^-----(BEGIN|END) [A-Za-z0-9 ]+-----\s*$/.test(line) ||
  /^[A-Za-z0-9+/=]{16,}\s*$/.test(line) ||
  /^[0-9a-f]{16,}\s*$/.test(line) ||
  /^#[ A-Za-z0-9-]*$/.test(line);

/**
 * Each line with whether it may stay. Block tags must be exact ("<ca>",
 * "</ca>", lower case, alone on the line) so where a block ends is never in
 * doubt between this and OpenVPN; inside a key block, only key data.
 */
const judged = (config: string) => {
  let block: string | undefined;
  return config.split(/\r?\n/).map((line) => {
    // OpenVPN reads a line 256 bytes at a time: a longer one's rest would be
    // read as an option of its own, which nothing here judged. A NUL ends a
    // line early the same way.
    if (utf8ByteLength(line) > 255 || line.includes("\0")) return { line, option: "a line over 255 bytes", ok: false };
    if (block) {
      if (line === `</${block}>`) {
        block = undefined;
        return { line, option: undefined, ok: true };
      }
      return { line, option: `<${block}> content`, ok: dataLine(line) };
    }
    if (/^\s*</.test(line)) {
      const tag = /^<(\/?)([a-z0-9-]+)>$/.exec(line);
      if (!tag) return { line, option: line.trim(), ok: false };
      const [, closing, name] = tag;
      // A <connection> holds options, checked like the rest; any other block must be key data.
      if (name === "connection") return { line, option: undefined, ok: true };
      if (closing) return { line, option: line, ok: false };
      block = name;
      return { line, option: name, ok: dataBlocks.has(name) };
    }
    const { option, args } = parsed(line);
    const fromFile = option !== undefined && readsFile.has(option) && args.length > 0 && args[0] !== "[inline]";
    // auth-user-pass with no file asks the console: the router gives its own (vpn/compile.ts).
    return {
      line,
      option: fromFile ? `${option} from a file` : option,
      ok: option === undefined || (allowed.has(option) && !fromFile),
    };
  });
};

/** The option each line sets, as read here: vpn/compile.ts strips its own the same way. */
export const ovpnOption = (line: string) => parsed(line).option;

/** The options in `config` a provider's client config may not set, each once. */
export const ovpnUnsafe = (config: string) => [
  ...new Set(judged(config).flatMap((l) => (l.ok ? [] : [l.option ?? l.line.trim()]))),
];

/** The file without them. */
export const ovpnSafeLines = (config: string) => judged(config).flatMap((l) => (l.ok ? [l.line] : []));
