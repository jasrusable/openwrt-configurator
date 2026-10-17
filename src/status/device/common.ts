// What the status probes share: JSON that may be empty, a probe that only
// hands back its output, JSON built by the shell, and the root-owned RAM dir
// a read keeps state in.
import type { Probe } from "../../deviceProbes";
import { parseJson } from "../../parseJson";

export const json = (stdout: string, what: string) => (stdout.trim() ? parseJson(stdout, what) : undefined);

export const raw = (command: string): Probe<string> => ({ command, parse: ({ stdout }) => stdout });

/**
 * Shell function `call <ubus call's arguments>`: its JSON answer, or null
 * when it fails or says nothing. Captured first, so one failing partway
 * cannot leave half its JSON. Answers go into one JSON value built by the
 * shell, never split on a marker: what a device says (an mDNS name, an SSID)
 * could hold any marker.
 */
export const ubusCall = `call() { r=$(ubus call "$@" 2>/dev/null) && [ -n "$r" ] && printf '%s' "$r" || printf null; }`;

/**
 * A JSON array with an object per hostapd interface (`$o` its ubus object,
 * `$d` its device), each `member` line printing its members; `[]` on a
 * device without Wi-Fi.
 */
export const eachHostapd = (members: string[]) =>
  [
    ubusCall,
    "printf '['; sep=''",
    "for o in $(ubus list 'hostapd.*' 2>/dev/null); do d=${o#hostapd.}",
    `  printf '%s{' "$sep"`,
    ...members.map((member) => `  ${member}`),
    "  printf '}'; sep=','",
    "done; printf ']'",
  ].join("\n");

/**
 * Shell setting `$s` to where reads keep things in RAM between them: a
 * directory of root's own under /var/run (root's alone to make things in, so
 * no one can plant it or a symlink first), checked all the same; else a fresh
 * one, removed when the probe ends, which only forgets.
 */
export const keptInRam =
  "s=/var/run/onc-status; (umask 077; mkdir -p $s 2>/dev/null); { [ -d $s ] && [ ! -L $s ] && [ -O $s ]; } || { s=$(mktemp -d); trap 'rm -rf \"$s\"' EXIT; }";
