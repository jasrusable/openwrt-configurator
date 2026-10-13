// A device's log: the lines worth telling, for Activity.
import { raw } from "./common";
import type { LogLine } from "./types";

/** logread's lines: "<Day Mon DD HH:MM:SS YYYY> <facility.level> <tag>: <message>". */
export const parseLog = (text: string): LogLine[] =>
  text.split("\n").flatMap((line) => {
    const m = /^\w{3} (\w{3}) +(\d+) (\d\d:\d\d:\d\d) (\d{4}) \S+ (.*)$/.exec(line.trim());
    if (!m) return [];
    const at = Date.parse(`${m[1]} ${m[2]} ${m[4]} ${m[3]}`);
    return Number.isFinite(at) ? [{ at, text: m[5] }] : [];
  });

/** What happened lately worth telling: links, interfaces, reboots, this app's own marks (see the Activity view). */
export const logProbe = raw(
  "logread -l 400 2>/dev/null | grep -E 'onc|netifd: Interface|link is (up|down)|odhcpd.*(Failed|error)|AP-ENABLED|AP-DISABLED|init complete|mwan3.*(online|offline)' | tail -n 120"
);
