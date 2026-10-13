// WireGuard: when each peer last completed a handshake (never `wg show
// dump`, which prints private keys).
import type { Probe } from "../../deviceProbes";
import type { WireguardPeer } from "./types";

/**
 * WireGuard's handshakes, after the device's clock: "<now>" then lines of
 * "<interface> <peer key> <unix time>". Never `wg show dump`, which prints
 * each interface's private key.
 */
export const handshakes: Probe<string> = {
  command: "date +%s; wg show all latest-handshakes 2>/dev/null || true",
  parse: ({ stdout }) => stdout,
};

export const parseHandshakes = (text: string): WireguardPeer[] => {
  const [first = "", ...lines] = text.split("\n");
  const now = Number(first.trim());
  return lines.flatMap((line) => {
    const [iface, publicKey, time] = line.trim().split(/\s+/);
    if (!iface || !publicKey || time === undefined) return [];
    const at = Number(time);
    return [{ iface, publicKey, ...(at > 0 && Number.isFinite(now) ? { since: Math.max(0, now - at) } : {}) }];
  });
};
