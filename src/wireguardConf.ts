// WireGuard's .conf files, as wg-quick and every WireGuard app read them: a
// provider's, pasted in to make a tunnel; a client's, written for it to scan.

export type WgConf = {
  privateKey: string;
  addresses: string[];
  dns: string[];
  /** [Interface] MTU, where the file sets one (some providers need less than WireGuard's 1420). */
  mtu?: number;
  peer: { publicKey: string; presharedKey?: string; endpoint?: string; allowedIps: string[] };
};

/** A .conf's [Interface] and its first [Peer]. Throws, saying what is missing. */
export const parseWgConf = (text: string): WgConf => {
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      const name = header[1].toLowerCase();
      // Only the first peer: a provider's file has one.
      current = sections[name] ? undefined : (sections[name] = {});
      continue;
    }
    const pair = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current[pair[1].toLowerCase()] = pair[2].trim();
  }
  const list = (value?: string) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const iface = sections.interface;
  const peer = sections.peer;
  if (!iface?.privatekey) throw new Error("No [Interface] PrivateKey in it.");
  if (!peer?.publickey) throw new Error("No [Peer] PublicKey in it.");
  const mtu = Number(iface.mtu);
  return {
    privateKey: iface.privatekey,
    addresses: list(iface.address),
    dns: list(iface.dns),
    ...(iface.mtu && Number.isInteger(mtu) ? { mtu } : {}),
    peer: {
      publicKey: peer.publickey,
      ...(peer.presharedkey ? { presharedKey: peer.presharedkey } : {}),
      ...(peer.endpoint ? { endpoint: peer.endpoint } : {}),
      allowedIps: list(peer.allowedips),
    },
  };
};

/** A .conf as WireGuard apps read it. */
export const formatWgConf = (conf: WgConf & { keepalive?: number }) =>
  [
    "[Interface]",
    `PrivateKey = ${conf.privateKey}`,
    `Address = ${conf.addresses.join(", ")}`,
    ...(conf.dns.length ? [`DNS = ${conf.dns.join(", ")}`] : []),
    ...(conf.mtu ? [`MTU = ${conf.mtu}`] : []),
    "",
    "[Peer]",
    `PublicKey = ${conf.peer.publicKey}`,
    ...(conf.peer.presharedKey ? [`PresharedKey = ${conf.peer.presharedKey}`] : []),
    ...(conf.peer.endpoint ? [`Endpoint = ${conf.peer.endpoint}`] : []),
    `AllowedIPs = ${conf.peer.allowedIps.join(", ")}`,
    ...(conf.keepalive ? [`PersistentKeepalive = ${conf.keepalive}`] : []),
    "",
  ].join("\n");
