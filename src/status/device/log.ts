// A device's log: the lines worth telling, for Activity.
import { raw } from "./common";
import type { LogLine } from "./types";

/**
 * `logread -t`'s lines: "<Day Mon DD HH:MM:SS YYYY> [<epoch s>.<ms>]
 * <facility.level> <tag>: <message>". The time is taken from the epoch: the
 * date before it is the device's local time, which this machine cannot read
 * in its own zone.
 */
export const parseLog = (text: string): LogLine[] =>
  text.split("\n").flatMap((line) => {
    const m = /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4} \[(\d+)\.(\d{3})\] \S+ (.*)$/.exec(line.trim());
    return m ? [{ at: Number(m[1]) * 1000 + Number(m[2]), text: m[3] }] : [];
  });

/** What happened lately worth telling: links, interfaces, reboots, this app's own marks (see the Activity view). */
export const logProbe = raw(
  "logread -t -l 400 2>/dev/null | grep -E 'onc|netifd: Interface|link is (up|down)|odhcpd.*(Failed|error)|AP-ENABLED|AP-DISABLED|init complete|mwan3.*(online|offline)' | tail -n 120"
);
