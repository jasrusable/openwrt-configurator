// The internet lines: mwan3's view of each, and the router's own checks
// (latency, DNS, the public address, smart queueing's drops).
import type { Probe } from "../../deviceProbes";
import { obj } from "../values";
import { json, keptInRam, raw } from "./common";
import type { InternetCheck, LineStatus } from "./types";

/**
 * Bare `nan`/`inf` as JSON values made readable (null). 25.12's mwan3 (2.12,
 * a ucode rpcd handler) answers `"age": nan` for a line online since boot
 * with no change: its time is `int("")`, and libubox prints NaN as is, which
 * no JSON parser takes, so every line's state was lost in exactly the steady
 * state. Drop once mwan3 or libubox write valid JSON:
 * https://github.com/openwrt/packages/issues/29653 (open).
 */
export const withoutBareNumbers = (text: string) =>
  text.replace(/([:\[,]\s*)[-+]?(nan|inf(inity)?)(?=\s*[,}\]])/gi, "$1null");

/** mwan3's lines, without what it pings (no need, and kept short). Nothing where mwan3 is not running. */
export const mwan3: Probe<unknown> = {
  command: "ubus call mwan3 status 2>/dev/null || echo '{}'",
  parse: ({ stdout }) => json(withoutBareNumbers(stdout || "{}"), "mwan3 status"),
};

/** `ubus call mwan3 status`, as each line's state and for how long. */
export const parseLines = (status: unknown): LineStatus[] =>
  Object.entries(obj(obj(status).interfaces)).map(([id, value]) => {
    const line = obj(value);
    const state = typeof line.status === "string" ? line.status : "unknown";
    const online = state === "online" || state === "disconnecting";
    const since = Number(online ? line.online : line.offline);
    return { id, state, since: Number.isFinite(since) ? since : 0 };
  });

/** busybox ping's output: each reply's time, and how many were sent and answered. */
export const parsePingOutput = (text: string) => {
  const counts = /(\d+) packets transmitted, (\d+) packets received/.exec(text);
  const times = [...text.matchAll(/ time=([\d.]+) ms/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  return counts ? { sent: Number(counts[1]), received: Number(counts[2]), times } : undefined;
};

/** Pings in numbers: the mean round trip, the share lost, and how much each differs from the one before (RFC 3550's sense). */
export const pingNumbers = (ping: ReturnType<typeof parsePingOutput>): { ms?: number; lossPercent?: number; jitterMs?: number } => {
  if (!ping || ping.sent === 0) return {};
  const round = (v: number) => Math.round(v * 10) / 10;
  const mean = ping.times.length ? ping.times.reduce((a, b) => a + b, 0) / ping.times.length : undefined;
  const steps = ping.times.slice(1).map((t, i) => Math.abs(t - ping.times[i]));
  return {
    ...(mean !== undefined ? { ms: round(mean) } : {}),
    lossPercent: Math.round(((ping.sent - Math.min(ping.received, ping.sent)) / ping.sent) * 100),
    ...(steps.length ? { jitterMs: round(steps.reduce((a, b) => a + b, 0) / steps.length) } : {}),
  };
};

/** The block between "== <name>" and the next "== ", as the check prints each ping's output. */
const block = (text: string, name: string) => {
  const start = text.indexOf(`== ${name}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + name.length + 4);
  const end = rest.search(/^== /m);
  return end < 0 ? rest : rest.slice(0, end);
};

/**
 * The router's checks (see internetCheck): "gateway <address or nothing>",
 * the pings' own output in "== internet" and "== gateway" blocks, then one
 * per line: "ip <address or ->", "dns <ok or fail>", "doh <port> <ok or
 * fail>", "qdisc <device> <sent bytes> <dropped>".
 */
export const parseInternetCheck = (text: string): InternetCheck => {
  const lines = text.split("\n").map((l) => l.trim().split(/\s+/));
  const field = (key: string) => lines.find((l) => l[0] === key)?.[1];
  const internet = pingNumbers(parsePingOutput(block(text, "internet")));
  const gateway = field("gateway");
  const toGateway = pingNumbers(parsePingOutput(block(text, "gateway")));
  const ip = field("ip");
  const doh = lines.filter((l) => l[0] === "doh" && /^\d+$/.test(l[1] ?? "")).map(([, port, ok]) => ({ port: Number(port), ok: ok === "ok" }));
  return {
    ...(internet.ms !== undefined ? { latencyMs: internet.ms } : {}),
    ...(internet.lossPercent !== undefined ? { lossPercent: internet.lossPercent } : {}),
    ...(internet.jitterMs !== undefined ? { jitterMs: internet.jitterMs } : {}),
    ...(gateway && /^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)
      ? {
          gateway,
          ...(toGateway.ms !== undefined ? { gatewayMs: toGateway.ms } : {}),
          ...(toGateway.lossPercent !== undefined ? { gatewayLossPercent: toGateway.lossPercent } : {}),
        }
      : {}),
    ...(ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? { publicIpv4: ip } : {}),
    dnsOk: field("dns") === "ok",
    ...(doh.length ? { doh } : {}),
    queues: lines.filter((l) => l[0] === "qdisc" && l.length >= 4).map(([, device, sent, dropped]) => ({
      device,
      sentBytes: Number(sent) || 0,
      dropped: Number(dropped) || 0,
    })),
  };
};

/**
 * The router's checks (see parseInternetCheck): at once, and given up after
 * a few seconds, so a dead line reads as "no answer" rather than a router
 * that did not answer in time. Each runs as a plain command in the
 * background so its pid is its own, and is killed when the time is up.
 * Four pings a second apart (busybox's ping takes whole seconds only) to
 * the internet and to the gateway: the mean, the loss and the jitter.
 */
export const internetCheckSeconds = 6;

/** Where latency is measured to, from the router. */
export const latencyTarget = "1.1.1.1";

export const internetCheck = (shaped: string[], doh: number[] = []) =>
  raw(
    [
      "d=$(mktemp -d); pids=",
      // The first default route's next hop; a PPPoE line's has none. Only an IPv4 address goes further.
      "g=$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == \"via\") { print $(i + 1); exit }}')",
      'case "$g" in *[!0-9.]*) g= ;; esac',
      `ping -c 4 -W 1 ${latencyTarget} >$d/ping 2>/dev/null & pids="$pids $!"`,
      '[ -n "$g" ] && { ping -c 4 -W 1 "$g" >$d/gw 2>/dev/null & pids="$pids $!"; }',
      // The public address, asked of ipify at most every 5 minutes (kept in the router's RAM), not every read.
      keptInRam,
      "f=$s/public-ip; fetched=",
      'if [ -s $f ] && find $f -mmin -5 2>/dev/null | grep -q .; then cp $f $d/ip; else fetched=1; uclient-fetch -q -T 4 -O $d/ip https://api.ipify.org >/dev/null 2>&1 & pids="$pids $!"; fi',
      'nslookup openwrt.org 127.0.0.1 >$d/dns 2>/dev/null & pids="$pids $!"',
      ...doh.map((port) => `nslookup -port=${port} -timeout=2 -retry=1 openwrt.org 127.0.0.1 >$d/doh${port} 2>/dev/null & pids="$pids $!"`),
      // busybox's sleep takes whole seconds only.
      'alive() { for p in $pids; do kill -0 $p 2>/dev/null && return 0; done; return 1; }',
      `i=0; while [ $i -lt ${internetCheckSeconds} ] && alive; do sleep 1; i=$((i+1)); done`,
      "kill $pids 2>/dev/null",
      'echo "gateway $g"',
      'echo "== internet"; cat $d/ping 2>/dev/null; echo "== gateway"; cat $d/gw 2>/dev/null; echo "== end"',
      'echo "ip $(head -c 15 $d/ip 2>/dev/null)"',
      "[ -n \"$fetched\" ] && grep -qE '^[0-9.]+$' $d/ip 2>/dev/null && cp $d/ip $f",
      "grep -q '^Name:' $d/dns && echo 'dns ok' || echo 'dns fail'",
      ...doh.map((port) => `grep -q '^Name:' $d/doh${port} && echo 'doh ${port} ok' || echo 'doh ${port} fail'`),
      "rm -rf $d",
      ...shaped.map(
        (device) =>
          `tc -s qdisc show dev ${device} 2>/dev/null | awk '/Sent/ {print "qdisc ${device}", $2, $7 + 0; exit}' | tr -d ','`
      ),
    ].join("; ")
  );
