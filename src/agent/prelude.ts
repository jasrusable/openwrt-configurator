// What every script this app runs on a device by verb (the apply's agent,
// script.ts; a firmware upgrade's, firmware/upgradeScript.ts) starts with:
// the lessons an SSH session taught, kept in one place. A script sets OUT (a
// file of its own, for a detached command's output) and calls
// leave_session_cgroup before anything else; each verb then says
// `ONC_<WORD>` on a line of its own when it went through (agent/index.ts
// `call` and `says` read it), its words on stderr when it did not.

export const prelude = `
# --- What every device script of openwrt-configurator starts with (src/agent/prelude.ts) ---

# To the system log, bounded: a wedged logd (its socket's queue full) blocks
# a writer, and must never stall a rollback. busybox has no \`timeout\` here.
say() {
	logger -t onc "$*" < /dev/null > /dev/null 2>&1 & say_pid=$!
	( sleep 2; kill "$say_pid" ) < /dev/null > /dev/null 2>&1 & say_killer=$!
	wait "$say_pid" 2> /dev/null; kill "$say_killer" 2> /dev/null
}

# A command that may leave a process behind (a service it starts, a daemon a
# hook forks, a download a timed-out call leaves): its output goes to $OUT and
# is passed on once it ends, never the session's own streams. A process left
# holding those would keep the SSH channel open, and the call would never
# end (seen in the rig: a stage that never answered). Its pid is in $OUT.pid
# while it runs, for a later call to stop it.
detached() {
	"$@" < /dev/null > "$OUT" 2>&1 & detached_pid=$!
	echo "$detached_pid" > "$OUT.pid"
	wait "$detached_pid"; detached_status=$?
	rm -f "$OUT.pid"; cat "$OUT" >&2; rm -f "$OUT"
	return $detached_status
}

# Out of the SSH session's cgroup, before anything else: procd runs dropbear
# in a cgroup of its own (/services/dropbear/instance1), and every verb
# starts in it, as dropbear's child. A process left there (the watchdog, a
# service this run restarted, sysupgrade) keeps procd from removing that
# cgroup, and a dropbear the run stopped is then never started again (seen on
# SNAPSHOT); a procd that kills a stopped service's cgroup would kill it
# mid-way. So each verb moves itself, and with it all it starts, into the
# agent's own cgroup where cgroup v2 is mounted, else the root one; where
# there are no cgroups, nothing. The session's dropbear stays where it is.
leave_session_cgroup() {
	cg="$ROOT/sys/fs/cgroup"
	[ -f "$cg/cgroup.procs" ] || return 0
	{ mkdir -p "$cg/onc" && echo $$ > "$cg/onc/cgroup.procs"; } 2> /dev/null || echo $$ > "$cg/cgroup.procs" 2> /dev/null
	return 0
}
`;

/** Write a device script owner-only (it is this app's, and may be given secrets on stdin), as `cat` reads it from stdin. */
export const writeScriptCommand = (path: string) => `umask 077 && cat > ${path} && chmod 700 ${path}`;
