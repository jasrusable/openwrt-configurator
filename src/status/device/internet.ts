// The internet lines: mwan3's view of each, and the router's own checks
// (latency, DNS, the public address, smart queueing's drops).
import type { Probe } from "../../deviceProbes";
import { obj } from "../values";
import { json, keptInRam, raw } from "./common";
import type { InternetCheck, LineStatus } from "./types";

/** mwan3's lines, without what it pings (no need, and kept short). Nothing where mwan3 is not running. */
export const mwan3: Probe<unknown> = {
  command: "ubus call mwan3 status 2>/dev/null || echo '{}'",
  parse: ({ stdout }) => json(stdout || "{}", "mwan3 status"),
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

/**
 * The Performance view's checks, one per line: "ping <avg ms or ->", "ip <address
 * or ->", "dns <ok or fail>", then "qdisc <device> <sent bytes> <dropped>" per
 * shaped device.
 */
export const parseInternetCheck = (text: string): InternetCheck => {
  const lines = text.split("\n").map((l) => l.trim().split(/\s+/));
  const field = (key: string) => lines.find((l) => l[0] === key)?.[1];
  const ping = Number(field("ping"));
  const ip = field("ip");
  return {
    ...(Number.isFinite(ping) && ping > 0 ? { latencyMs: ping } : {}),
    ...(ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? { publicIpv4: ip } : {}),
    dnsOk: field("dns") === "ok",
    queues: lines.filter((l) => l[0] === "qdisc" && l.length >= 4).map(([, device, sent, dropped]) => ({
      device,
      sentBytes: Number(sent) || 0,
      dropped: Number(dropped) || 0,
    })),
  };
};

/**
 * The Performance view's checks, from the router (see parseInternetCheck):
 * at once, and given up after a few seconds, so a dead line reads as "no
 * answer" rather than a router that did not answer in time. Each runs as a
 * plain command in the background so its pid is its own, and is killed when
 * the time is up.
 */
export const internetCheckSeconds = 6;

/** Where latency is measured to, from the router. */
export const latencyTarget = "1.1.1.1";

export const internetCheck = (shaped: string[]) =>
  raw(
    [
      "d=$(mktemp -d)",
      `ping -c 3 -W 2 ${latencyTarget} >$d/ping 2>/dev/null & p1=$!`,
      // The public address, asked of ipify at most every 5 minutes (kept in the router's RAM), not every read.
      keptInRam,
      "f=$s/public-ip; p2=; fetched=",
      "if [ -s $f ] && find $f -mmin -5 2>/dev/null | grep -q .; then cp $f $d/ip; else fetched=1; uclient-fetch -q -T 4 -O $d/ip https://api.ipify.org >/dev/null 2>&1 & p2=$!; fi",
      "nslookup openwrt.org 127.0.0.1 >$d/dns 2>/dev/null & p3=$!",
      // busybox's sleep takes whole seconds only.
      `i=0; while [ $i -lt ${internetCheckSeconds} ]; do kill -0 $p1 2>/dev/null || kill -0 $p2 2>/dev/null || kill -0 $p3 2>/dev/null || break; sleep 1; i=$((i+1)); done`,
      "kill $p1 $p2 $p3 2>/dev/null",
      `echo "ping $(sed -n 's/.*= [0-9.]*\\/\\([0-9.]*\\)\\/.*/\\1/p' $d/ping)"`,
      'echo "ip $(head -c 15 $d/ip 2>/dev/null)"',
      "[ -n \"$fetched\" ] && grep -qE '^[0-9.]+$' $d/ip 2>/dev/null && cp $d/ip $f",
      "grep -q '^Name:' $d/dns && echo 'dns ok' || echo 'dns fail'",
      "rm -rf $d",
      ...shaped.map(
        (device) =>
          `tc -s qdisc show dev ${device} 2>/dev/null | awk '/Sent/ {print "qdisc ${device}", $2, $7 + 0; exit}' | tr -d ','`
      ),
    ].join("; ")
  );
