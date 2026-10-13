// What the status probes share: JSON that may be empty, a probe that only
// hands back its output, and the root-owned RAM dir a read keeps state in.
import type { Probe } from "../../deviceProbes";
import { parseJson } from "../../parseJson";

export const json = (stdout: string, what: string) => (stdout.trim() ? parseJson(stdout, what) : undefined);

export const raw = (command: string): Probe<string> => ({ command, parse: ({ stdout }) => stdout });

/**
 * Shell setting `$s` to where reads keep things in RAM between them: a
 * directory of root's own (in /tmp anyone may make it first, or plant a
 * symlink there), else a fresh one, which only forgets.
 */
export const keptInRam =
  's=/tmp/onc-status; (umask 077; mkdir -p $s 2>/dev/null); { [ -d $s ] && [ ! -L $s ] && [ -O $s ]; } || s=$(mktemp -d)';
