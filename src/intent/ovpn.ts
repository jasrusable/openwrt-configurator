// A provider's .ovpn is pasted from elsewhere and run by OpenVPN as root: a
// line that runs a program, loads a plugin, reads another config or writes a
// file there would run whatever the file's author chose. So a file may hold
// only the client options providers use (an allowlist: a denylist misses one,
// or a quoted spelling), each line read as OpenVPN reads it; anything else is
// refused, not edited, so the user sees why. ovpnFile also drops what is not
// allowed and ends with script-security 1, in case one slips past.

/** What a provider's client config may set. Routes and the device are the router's (features/vpn.ts). */
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
  "http-proxy", "http-proxy-option", "socks-proxy", "peer-fingerprint", "machine-readable-output", "auth-token-user",
]);

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

/** The option a line sets ("--up" is "up"; "setenv opt X" is X), lower-cased; undefined for none. */
const optionOf = (line: string) => {
  const [first, ...rest] = words(line);
  if (first === undefined) return undefined;
  const name = first.replace(/^--/, "").toLowerCase();
  // "setenv opt <option>" still sets a known option: it is that option.
  return name === "setenv" && rest[0]?.toLowerCase() === "opt" ? (rest[1] ?? "").replace(/^--/, "").toLowerCase() : name;
};

/** Each line with whether it may stay: data inside key blocks always, options only if allowed. */
const judged = (config: string) => {
  let block: string | undefined;
  return config.split(/\r?\n/).map((line) => {
    const tag = /^\s*<(\/?)([A-Za-z0-9-]+)>\s*$/.exec(line);
    if (tag) {
      const [, closing, name] = tag;
      const lower = name.toLowerCase();
      if (closing) {
        if (block === lower) block = undefined;
        return { line, option: undefined, ok: true };
      }
      // A <connection> holds options, checked like the rest; any other block must be data.
      if (lower === "connection") return { line, option: undefined, ok: true };
      block = lower;
      return { line, option: lower, ok: dataBlocks.has(lower) };
    }
    if (block) return { line, option: undefined, ok: true };
    const option = optionOf(line);
    return { line, option, ok: option === undefined || allowed.has(option) };
  });
};

/** The options in `config` a provider's client config may not set, each once. */
export const ovpnUnsafe = (config: string) => [
  ...new Set(judged(config).flatMap((l) => (l.ok ? [] : [l.option ?? l.line.trim()]))),
];

/** The file without them. */
export const ovpnSafeLines = (config: string) => judged(config).flatMap((l) => (l.ok ? [l.line] : []));
