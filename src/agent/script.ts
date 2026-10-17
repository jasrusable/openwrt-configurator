// The device side of an apply, as one fixed script: `onc-agent`. A run writes
// it once (/tmp/onc-agent-<runId>.sh, paths.ts) and every later step calls one
// of its verbs; nothing from the config is ever written into it. What a verb
// needs comes as records on stdin (records.ts) or a few plain arguments, or
// is kept in its run directory, and paths grow from ONC_ROOT and ONC_TMP, so
// the whole script is tested under plain sh in a temp dir (agent.test.ts).
//
//   begin                     a fresh run directory
//   revert                    discard every staged uci change, whoever made it
//   prepare < records         revert, seed missing owned configs, packages, the reload baseline
//   stage < records           the uci batch (the wipe and the declared config), then files
//   finalise < records        commit each config, reload_config, then the commit's marker
//   services < records        enable and start, or stop and disable, each declared service;
//                             restart one with no reload trigger for a config this run changed
//   hooks < records           the run_after_reload commands, once the config is live
//   stage-packages <pkg>...   fetch them for an offline reinstall; prints the count
//   arm [options] < lists     snapshots, the boot-time copy, the watchdog
//   commit-finished           whether the commit's marker is there
//   asleep                    whether the watchdog still sleeps, and the seconds before it fires
//   disarm                    stand the watchdog down (the applied marker set, if this run
//                             committed); or say it fired
//   done                      the run is over here: what it leaves, removed
//   rollback-now              end the watchdog's wait: it restores now (one that died, a new one)
//   recovered                 once its restore is done, tell it access is back
//   drop                      undo a failed or refused arm
//   watchdog                  (started by arm) wait, then restore unless confirmed
//
// The steps that change the device (prepare, stage, finalise, services,
// hooks) say each step on stdout as they start it ("ONC_STEP <what>": a
// path, a package, a config, never a value) and "ONC_OK" once all are done;
// one that fails stops the verb, its words on stderr. Writing to stdout is
// also what ends an abandoned verb: dropbear never signals a command when the
// link drops, but the next write takes SIGPIPE once it is gone, so a verb
// left running stops within a step, while a step that writes nothing
// (reload_config) runs to its end. On a blackholed link dropbear may not even
// notice for SSHKeepAlive (300 s by default), so an abandoned verb can run on
// while the watchdog restores (measured on 25.12.5: a loop writing only to a
// file ran to its end after its client was killed; one writing stdout died).
//
// Lessons kept here, each found the hard way (and those every device script
// shares, in prelude.ts: the log bounded, detached commands, the cgroup):
// - Per-run paths: with fixed ones, a second run inside the window cleared the
//   flag that had disarmed the first, whose watchdog then restored a stale
//   snapshot over a good device.
// - A pid is reused once its process ends: a saved pid is acted on only while
//   it is still what it was (the watchdog's own `sleep`, by its parent, or
//   this run's watchdog), and a disarm answers "disarmed" only on evidence.
// - A snapshot is whole or the arm fails: a partial one (a /tmp full of staged
//   packages) swapped in whole would leave less than either config.
// - Never kill the watchdog: once it has started restoring (`restoring`), half
//   a restore is worse than either config, so a late disarm says "fired".
// - The restored config is copied beside /etc/config and swapped: a failed
//   copy (an overlay full from apk, which is when rollbacks fire) must never
//   leave the device without one.
// - Staged UCI changes are dropped right after the swap, before any apk step:
//   every uci read applies /tmp/.uci on top of the files, and a postinst's
//   bare `uci commit` would commit them over the restored config.
// - Packages: this run's new ones go first, then removed ones come back from
//   staged .apk files with no repositories (offline): wpad variants conflict.
// - Boot links are restored in every mode (/etc/config does not hold them),
//   and the services this run touched are put back running or not.
// - `setsid`, not `at` or `nohup` (absent on a stock image); dropbear never
//   signals a command when the link drops, but SIGPIPE on stdout kills it, so
//   the watchdog writes nowhere a dropped session could close.
// - The boot-time copy on flash (/etc/onc/rollback/<runId>) and its early
//   init script cover a device restarted inside the window, when /tmp and the
//   watchdog are gone: the config, the managed files and the boot links come
//   back, not packages (their staged files were in /tmp). A confirm removes
//   every run's copy.
// - Another run's watchdog still alive on a device means its snapshot is
//   restored at its deadline, over whatever came since: a run's planning
//   refuses such a device until it is over (\`fires\` says when; apply/plan.ts).
import { agentName, appliedKeepList, appliedMarker, deviceTmp, runDirName, stepsDirName, watchdogPidFile } from "./paths";
import { prelude } from "./prelude";

/**
 * Restores the config of an apply never confirmed when the device restarts
 * inside its window: early at boot (START=11, before the network), the oldest
 * copy if several, then all are dropped.
 */
export const bootScript = `#!/bin/sh /etc/rc.common
# openwrt-configurator: the device restarted inside an apply's rollback window.
START=11
start() { return 0; }
boot() {
	root="\${ONC_ROOT:-}"
	for d in $(ls -dtr "$root"/etc/onc/rollback/*/ 2>/dev/null); do
		[ -d "$d/config" ] || continue
		rm -rf "$root/etc/config.onc-new" "$root/etc/config.onc-failed"
		if cp -a "$d/config" "$root/etc/config.onc-new"; then
			mv "$root/etc/config" "$root/etc/config.onc-failed" && mv "$root/etc/config.onc-new" "$root/etc/config"
			# The system log is not running this early: the kernel's is.
			(echo "onc: restarted inside an unconfirmed apply's rollback window: its config restored" > /dev/kmsg) 2>/dev/null
		fi
		# What else the run changed, when the copy holds it whole: the files
		# it made go, those it changed come back, then the boot links, swapped
		# in only once copied. Packages stay as they are: their staged files
		# were in /tmp.
		if [ -d "$d/extra" ]; then
			while IFS= read -r p; do rm -f "$root$p"; done < "$d/extra/delete"
			[ ! -d "$d/extra/files" ] || cp -a "$d/extra/files/." "$root/"
			if [ -d "$d/extra/rc.d" ] && rm -rf "$root/etc/rc.d.onc-new" && cp -a "$d/extra/rc.d" "$root/etc/rc.d.onc-new"; then
				rm -rf "$root/etc/rc.d.onc-old"
				mv "$root/etc/rc.d" "$root/etc/rc.d.onc-old" && mv "$root/etc/rc.d.onc-new" "$root/etc/rc.d" && rm -rf "$root/etc/rc.d.onc-old"
			fi
			(echo "onc: and its files and boot links; its packages are as the apply left them" > /dev/kmsg) 2>/dev/null
		fi
		break
	done
	rm -rf "$root/etc/onc/rollback"
}
`;

export const agentScript = `#!/bin/sh
# onc-agent: the device side of openwrt-configurator's commit-confirm.
# Written by an apply for its run alone; see src/agent/script.ts.

ROOT="\${ONC_ROOT:-}"
TMP="\${ONC_TMP:-${deviceTmp}}"
AGENT="$0"
RUN="\${AGENT##*/${agentName}}"; RUN="\${RUN%.sh}"
R="$TMP/${runDirName}$RUN"
W="$TMP/${stepsDirName}$RUN"
DISARMED="$R.disarmed"
BOOT_ROOT="$ROOT/etc/onc/rollback"
BOOT="$BOOT_ROOT/$RUN"
INIT="$ROOT/etc/init.d/onc-rollback"
# A detached command's output, in the step verbs' own directory.
OUT="$W/out"
${prelude}

# What a pid runs now, and its parent, from /proc (ps where there is none, as in tests).
comm_of() { { cat "/proc/$1/comm"; } 2>/dev/null || ps -o comm= -p "$1" 2>/dev/null; }
args_of() { { tr '\\0' '\\n' < "/proc/$1/cmdline"; } 2>/dev/null || ps -o args= -p "$1" 2>/dev/null | tr ' ' '\\n'; }
ppid_of() { sed -n 's/^PPid:[[:space:]]*//p' "/proc/$1/status" 2>/dev/null || ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
is_watchdog() { [ -n "$1" ] && args_of "$1" | grep -qxF "$AGENT" && args_of "$1" | grep -qx watchdog; }
# The watchdog's own sleep, by its parent: a saved pid is reused once its process ends.
own_sleep() {
	[ -n "$1" ] && [ -n "$2" ] && [ "$(ppid_of "$1")" = "$2" ] &&
		case "$(comm_of "$1")" in sleep | */sleep) true ;; *) false ;; esac
}
gone() { ! kill -0 "$1" 2>/dev/null; }
# Until "$@" holds: checked at once, then each second (busybox sleeps whole
# seconds only, and a spin forking a check is too dear on a slow router), 5 at most.
settle() {
	i=0
	until "$@"; do
		[ $i -ge 5 ] && return 1
		sleep 1; i=$((i+1))
	done
}

# Whether procd runs service $1: what the apply's own start step goes by.
procd_knows() { ubus call service list "{\\"name\\":\\"$1\\"}" 2>/dev/null | grep -q "^[[:space:]]*\\"$1\\""; }

# Every staged uci change, whoever made it: a run starts and ends from
# committed state. Read on the device, so it covers packages nothing here
# knows; guarded, as \`uci revert\` fails on a config that is not there. LuCI's
# unsaved edits are rpcd's, per session, which \`uci changes\` never sees.
revert_pending() {
	for pkg in $(uci changes | sed 's/^[-+]//; s/[.=].*//' | sort -u); do
		if [ -f "$ROOT/etc/config/$pkg" ]; then uci revert "$pkg" || return 1; fi
	done
}

cleanup() { rm -rf "$R" "$W" "$AGENT"; }

begin() {
	rm -rf "$R" "$DISARMED" "$R.committed"
	mkdir -p "$R" && echo ONC_BEGUN
}

# --- The steps an apply changes the device with (prepare ... hooks) ---

step() { printf 'ONC_STEP %s\\n' "$*"; }

# The verb's records (stdin), kept: refused unless they end with "end", as
# one cut short must not be half done.
read_input() {
	IN="$W/in"
	cat > "$IN" || return 1
	[ "$(tail -n 1 "$IN")" = end ] || { echo "onc-agent: its input was cut short" >&2; return 1; }
}

# The next of a header's fields, into $f, the rest left in $rest.
next_field() { f=\${rest%% *}; rest=\${rest#"$f"}; rest=\${rest# }; }
counted() { case "$1" in '' | *[!0-9]*) echo "onc-agent: a bad count in: $h" >&2; return 1 ;; esac; }

# Each record, to "$1": its kind, the rest of its header in $rest, its body
# (if it has one) in $W/body, $n1 lines of it for a write's content. A header
# is read by its line number, and a body taken whole by sed: no shell loop
# over content, which is slow on a small router, and none changes a byte.
each_record() {
	n=1; last=$(($(wc -l < "$IN")))
	while [ "$n" -lt "$last" ]; do
		h=$(sed -n "\${n}p;\${n}q" "$IN"); n=$((n+1))
		kind=\${h%% *}; rest=\${h#"$kind"}; rest=\${rest# }
		c=0
		case "$kind" in
			seed | batch | set | add_list | run) next_field; c=$f; counted "$c" || return 1 ;;
			write) next_field; n1=$f; next_field; n2=$f; counted "$n1" && counted "$n2" || return 1; c=$((n1+n2)) ;;
		esac
		if [ "$c" -gt 0 ]; then
			sed -n "\${n},$((n+c-1))p;$((n+c-1))q" "$IN" > "$W/body" || return 1
			n=$((n+c))
		fi
		"$1" "$kind" || return 1
	done
}

# A list file's lines as words, for a step's label.
words() { w=$(tr '\\n' ' ' < "$1"); echo "\${w% }"; }

# A value body's text: its one trailing line break off, any of its own kept.
value_of() { v=$(cat "$1"; echo x); v=\${v%x}; v=\${v%?}; }

# Install and remove packages, with everything that changes config behind
# our back, before the config is read: a package's postinst and uci-defaults
# add sections and whole configs.
prepare_record() {
	case "$kind" in
		# Written only where missing, owner-only (a config can hold secrets),
		# before packages: apk keeps a config that exists and sets its own
		# aside (.apk-new), so a new package's first start reads ours.
		seed)
			step "seed $rest"
			printf '%s\\n' "$rest" >> "$W/seeds"
			[ -e "$ROOT$rest" ] && return 0
			(umask 077; cat "$W/body" > "$ROOT$rest") || return 1 ;;
		remove) printf '%s\\n' "$rest" >> "$W/remove" ;;
		add) printf '%s\\n' "$rest" >> "$W/add" ;;
		*) echo "onc-agent prepare: unexpected $kind" >&2; return 1 ;;
	esac
}

prepare() {
	: > "$W/seeds"; : > "$W/remove"; : > "$W/add"
	# First: a postinst's bare \`uci commit\` would commit whatever is staged.
	step "revert pending changes"
	revert_pending >&2 || return 1
	each_record prepare_record || return 1
	# Removed first, then installed: as many as there are, by one apk each.
	if [ -s "$W/remove" ]; then step "apk del --rdepends $(words "$W/remove")"; detached apk del --rdepends $(cat "$W/remove") || return 1; fi
	if [ -s "$W/add" ]; then step "apk add --update-cache $(words "$W/add")"; detached apk add --update-cache $(cat "$W/add") || return 1; fi
	# The stock configs apk set aside for one of ours: never used.
	if [ -s "$W/remove" ] || [ -s "$W/add" ]; then
		while IFS= read -r p; do rm -f "$ROOT$p.apk-new"; done < "$W/seeds"
	fi
	# Every config into procd's change baseline (/var/run/config.md5), before
	# anything is staged: installing a package never refreshes it, so the
	# closing reload would fire nothing for a config new since boot; and
	# reload_config compares \`uci show\`, staged deltas included, so after
	# staging it would record this run's own changes as the baseline.
	step reload_config
	detached reload_config
}

# The wipe and the declared config, then the managed files: before the
# commit, so a failure leaves nothing a revert cannot undo but files (the
# watchdog's), and a new hotplug script is in place for the reload.
stage_record() {
	case "$kind" in
		# \`uci batch\` exits 0 when an operation fails, saying so on stderr only.
		batch)
			step "uci batch"
			uci batch < "$W/body" > /dev/null 2> "$W/uci.err"
			if [ -s "$W/uci.err" ]; then cat "$W/uci.err" >&2; rm -f "$W/uci.err"; return 1; fi
			rm -f "$W/uci.err" ;;
		set | add_list)
			step "uci $kind $rest"
			value_of "$W/body"
			uci "$kind" "$rest=$v" >&2 ;;
		remove-file)
			step "remove $rest"
			# A service whose init script goes is stopped first: removing the
			# file leaves procd running it until a reboot.
			case "$rest" in
				/etc/init.d/*/*) ;;
				/etc/init.d/*) if [ -x "$ROOT$rest" ]; then "$ROOT$rest" stop; "$ROOT$rest" disable; fi > /dev/null 2>&1 ;;
			esac
			rm -f "$ROOT$rest" ;;
		write) write_file ;;
		*) echo "onc-agent stage: unexpected $kind" >&2; return 1 ;;
	esac
}

# Beside the file first, owner-only until its mode is set (a secret is never
# readable by others), moved over it only if it differs, and only then its
# run_after: an apply that changes nothing restarts nothing.
write_file() {
	next_field; mode=$f; f="$ROOT$rest"
	step "write $rest"
	mkdir -p "$(dirname "$f")" || return 1
	(umask 077; sed -n "1,\${n1}p" "$W/body" > "$f.onc-new") && chmod "$mode" "$f.onc-new" || return 1
	if cmp -s "$f.onc-new" "$f"; then
		rm -f "$f.onc-new"; chmod "$mode" "$f"
	else
		mv -f "$f.onc-new" "$f" || return 1
		if [ "$n2" -gt 0 ]; then
			step "run_after $rest"
			sed -n "$((n1+1)),\\$p" "$W/body" > "$W/after"
			detached sh "$W/after" || return 1
		fi
	fi
}

stage() { each_record stage_record; }

# Commit each config this run changed, by name (a bare \`uci commit\` would
# commit anyone's staged changes), then the reload, then the commit's marker.
# Guarded: \`uci commit\` and \`uci revert\` exit 1 on a config that is not
# there (verified on 25.12.5).
finalise_record() {
	case "$kind" in
		commit)
			step "commit $rest"
			if [ -f "$ROOT/etc/config/$rest" ]; then uci commit "$rest" >&2 || return 1; fi ;;
		protocol) printf '%s\\n' "$rest" >> "$W/protocols" ;;
		*) echo "onc-agent finalise: unexpected $kind" >&2; return 1 ;;
	esac
}

# The configs the reload is about to signal as changed, by the test
# reload_config itself makes: each one's \`uci show\` against the md5s it kept
# at the last reload. The services step restarts what has no trigger for one.
changed_configs() {
	for c in "$ROOT"/etc/config/*; do
		c=\${c##*/}
		now=$(uci show "$c" 2> /dev/null | md5sum | cut -d" " -f1)
		was=$(grep " /var/run/config.check/$c\$" "$ROOT/var/run/config.md5" 2> /dev/null | cut -d" " -f1)
		[ "$now" = "$was" ] || echo "$c"
	done > "$W/changed"
}

finalise() {
	: > "$W/protocols"
	each_record finalise_record || return 1
	changed_configs
	step reload_config
	# Nothing written from here: the reload can drop the link, and the next
	# write would end this verb. Its output nowhere: nothing it leaves behind
	# holds the channel. Then the commit's marker, which confirming checks (a
	# link dropped during the commits looks the same as one the reload
	# dropped): there only once the commits and the reload are done, so a
	# verb ended at the step's write above leaves none, and is rolled back.
	reload_config < /dev/null > /dev/null 2>&1
	touch "$R/committed" 2> /dev/null
	# netifd learns protocol handlers only as it starts, so one a package of
	# this run brought (wireguard) leaves its interface down until it restarts.
	while IFS= read -r p; do
		ubus call network get_proto_handlers 2> /dev/null | grep -q "\\"$p\\":" || { "$ROOT/etc/init.d/network" restart > /dev/null 2>&1; break; }
	done < "$W/protocols"
}

# Enabled at boot and started (a package enables its service only when first
# installed, and procd holds a stopped service's reload triggers nowhere),
# "started" meaning procd knows it: sqm and the firewall run no process, and
# starting them again would apply them again for nothing. Or, unused, stopped
# and disabled: an empty config is not always nothing. A missing init script
# is skipped, a failure said, not fatal: the check after says what runs.
# "<service> <config>": restarted if this run changed the config, as no
# reload trigger of the service's watches it; "<service>" alone: restarted
# (a package swap the plan already knows this run made).
restart_record() {
	next_field; init="$ROOT/etc/init.d/$f"
	[ -x "$init" ] || return 0
	[ -z "$rest" ] || grep -qx "$rest" "$W/changed" 2> /dev/null || return 0
	step "restart $f"
	detached "$init" restart || echo "could not restart $f" >&2
}

services_record() {
	[ "$kind" = restart ] && { restart_record; return; }
	s=$rest; init="$ROOT/etc/init.d/$s"
	[ -x "$init" ] || return 0
	case "$kind" in
		enable)
			step "enable $s"
			"$init" enabled || detached "$init" enable || echo "could not enable $s" >&2
			procd_knows "$s" || detached "$init" start || echo "could not start $s" >&2 ;;
		disable)
			step "disable $s"
			! "$init" enabled || detached "$init" disable || echo "could not disable $s" >&2
			! "$init" running > /dev/null 2>&1 || "$init" stop > /dev/null 2>&1 || echo "could not stop $s" >&2 ;;

		*) echo "onc-agent services: unexpected $kind" >&2; return 1 ;;
	esac
}

services() { each_record services_record; }

hooks_record() {
	[ "$kind" = run ] || { echo "onc-agent hooks: unexpected $kind" >&2; return 1; }
	hook=$((hook+1))
	step "hook $hook"
	cp "$W/body" "$W/after" && detached sh "$W/after"
}

hooks() { hook=0; each_record hooks_record; }

# A step verb: its records read, then done, saying so; what it read goes
# either way. In a directory of its own, owner-only (its records can hold
# secrets), not the watchdog's: one standing down removes that, and hooks
# run after the disarm.
steps() {
	(umask 077; mkdir -p "$W") || return 1
	read_input && "$1"; s=$?
	rm -f "$W/in" "$W/body" "$W/after"
	[ $s -eq 0 ] && echo ONC_OK
	return $s
}

stage_packages() {
	mkdir -p "$R/packages"
	apk fetch --output "$R/packages" "$@" >/dev/null 2>&1
	echo "ONC_STAGED $(ls "$R/packages"/*.apk 2>/dev/null | wc -l)"
}

# The boot script, then its link: before rc.d is copied, so a restore keeps it.
install_boot_script() {
	cat > "$INIT.onc-new" <<'ONC_BOOT_SCRIPT' || return 1
${bootScript}ONC_BOOT_SCRIPT
	chmod 0755 "$INIT.onc-new" && mv "$INIT.onc-new" "$INIT" &&
		mkdir -p "$ROOT/etc/rc.d" && ln -sf ../init.d/onc-rollback "$ROOT/etc/rc.d/S11onc-rollback"
}

# Everything a restore puts back, or nothing: a partial copy (a /tmp full of
# staged packages) swapped in whole would leave less than either side.
snapshot() {
	printf '%s\\n' "$timeout" > "$R/timeout" && printf '%s\\n' "$mode" > "$R/mode" &&
		printf '%s\\n' "$recover" > "$R/recover" && printf '%s\\n' "$wireless" > "$R/wireless" || return 1
	cp -a "$ROOT/etc/config" "$R/config" || return 1
	if [ -d "$ROOT/etc/rc.d" ]; then cp -a "$ROOT/etc/rc.d" "$R/rc.d" || return 1; fi
	# Which of this run's services are running.
	: > "$R/running" || return 1
	while IFS= read -r s; do
		procd_knows "$s" || continue
		printf '%s\\n' "$s" >> "$R/running" || return 1
	done < "$R/services"
	# Every file the run touches, as it is: one listed but gone is skipped.
	while IFS= read -r p; do
		[ -e "$ROOT$p" ] || [ -L "$ROOT$p" ] || continue
		mkdir -p "$(dirname "$R/files$p")" && cp -a "$ROOT$p" "$R/files$p" || return 1
	done < "$R/restore"
}

arm() {
	timeout=90 mode=reload-then-reboot recover=60 wireless=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--timeout) timeout="$2"; shift ;;
			--mode) mode="$2"; shift ;;
			--recover) recover="$2"; shift ;;
			--wireless) wireless=1 ;;
			*) echo "onc-agent arm: unknown option $1" >&2; return 2 ;;
		esac
		shift
	done
	# What a rollback puts back, a line each on stdin: "<list> <item>" (an item
	# may hold spaces, never a line break: refused before it gets here). On
	# stdin, as a long command line is refused by dropbear.
	for l in delete restore new-packages services restart; do : > "$R/$l" || return 1; done
	while IFS= read -r line; do
		item="\${line#* }"
		case "\${line%% *}" in
			delete) l=delete ;;
			restore) l=restore ;;
			new-package) l=new-packages ;;
			service) l=services ;;
			restart) l=restart ;;
			*) [ -z "$line" ] && continue; echo "onc-agent arm: unknown list in: $line" >&2; return 2 ;;
		esac
		printf '%s\\n' "$item" >> "$R/$l" || return 1
	done
	install_boot_script || { rm -f "$INIT.onc-new"; say "no room on flash for the boot-time rollback script"; }
	snapshot || { echo "onc-agent: could not snapshot the device (no room in $TMP?)" >&2; return 1; }
	# On flash too: a flash too full for it only loses this extra. The config
	# first; then, whole or not at all, what else a restore puts back.
	{ mkdir -p "$BOOT" && cp -a "$ROOT/etc/config" "$BOOT/config"; } || { rm -rf "$BOOT"; say "no room on flash for a boot-time rollback copy"; }
	if [ -d "$BOOT" ]; then
		{ mkdir -p "$BOOT/extra.onc-new" && cp "$R/delete" "$BOOT/extra.onc-new/delete" &&
			{ [ ! -d "$R/files" ] || cp -a "$R/files" "$BOOT/extra.onc-new/files"; } &&
			{ [ ! -d "$R/rc.d" ] || cp -a "$R/rc.d" "$BOOT/extra.onc-new/rc.d"; } &&
			mv "$BOOT/extra.onc-new" "$BOOT/extra"; } ||
			{ rm -rf "$BOOT/extra.onc-new"; say "no room on flash for the boot-time copy of the managed files: a restart restores the config only"; }
	fi
	setsid sh "$AGENT" watchdog < /dev/null > /dev/null 2>&1 &
	# Armed once its watchdog sleeps: until then a disarm or rollback-now could not find it.
	settle [ -s "$R/sleep.pid" ] || { echo "onc-agent: the watchdog did not start" >&2; return 1; }
	echo ONC_ARMED
}

watchdog() {
	[ -d "$R" ] || exit 0
	echo $$ > "$R/${watchdogPidFile}"
	# When it fires, on the device's own clock: what asleep says, and what
	# another run's planning waits for.
	echo $(( $(date +%s) + $(cat "$R/timeout") )) > "$R/fires"
	sleep "$(cat "$R/timeout")" & echo $! > "$R/sleep.pid"; wait $!
	# Dropped meanwhile (an arm taken back): there is nothing of this run to restore.
	[ -d "$R" ] || exit 0
	# Standing down: its markers first, so a disarm never finds neither them nor the run.
	if [ -f "$R/confirmed" ]; then
		[ ! -f "$R/committed" ] || touch "$R.committed"
		touch "$DISARMED"; rm -rf "$BOOT" "$R"; exit 0
	fi
	# Past the point of no return: a disarm from now on must say it fired.
	touch "$R/restoring"
	mode="$(cat "$R/mode")"
	say "provision not confirmed in time, rolling back [$mode]"
	rm -rf "$ROOT/etc/config.onc-new" "$ROOT/etc/config.onc-failed"
	if cp -a "$R/config" "$ROOT/etc/config.onc-new"; then
		mv "$ROOT/etc/config" "$ROOT/etc/config.onc-failed" && mv "$ROOT/etc/config.onc-new" "$ROOT/etc/config"
	else
		say "rollback: could not stage the config snapshot, leaving current config in place"
	fi
	rm -rf "$BOOT"
	revert_pending
	while IFS= read -r p; do rm -f "$ROOT$p"; done < "$R/delete"
	while IFS= read -r p; do
		[ -e "$R/files$p" ] || [ -L "$R/files$p" ] || continue
		mkdir -p "$(dirname "$ROOT$p")" && cp -a "$R/files$p" "$ROOT$p"
	done < "$R/restore"
	if [ -s "$R/new-packages" ]; then
		apk del $(cat "$R/new-packages") > /dev/null 2>&1 || say "rollback could not remove newly installed packages"
	fi
	# No repositories at all: it resolves from the staged files alone, so it
	# works with the network down (verified on the device).
	if ls "$R/packages"/*.apk > /dev/null 2>&1; then
		apk add --allow-untrusted --repositories-file /dev/null "$R/packages"/*.apk > /dev/null 2>&1 || say "rollback could not reinstall removed packages"
	fi
	if [ -d "$R/rc.d" ] && rm -rf "$ROOT/etc/rc.d.onc-new" && cp -a "$R/rc.d" "$ROOT/etc/rc.d.onc-new"; then
		rm -rf "$ROOT/etc/rc.d.onc-old"
		mv "$ROOT/etc/rc.d" "$ROOT/etc/rc.d.onc-old" && mv "$ROOT/etc/rc.d.onc-new" "$ROOT/etc/rc.d" && rm -rf "$ROOT/etc/rc.d.onc-old"
	fi
	sync
	if [ "$mode" = reboot ]; then reboot; exit 0; fi
	# procd only re-reads what it is told to: reload_config fires the
	# triggers of every config that changed.
	reload_config
	[ "$(cat "$R/wireless")" = 1 ] && wifi reload
	while IFS= read -r s; do
		[ -x "$ROOT/etc/init.d/$s" ] || continue
		if grep -qxF "$s" "$R/running" 2> /dev/null; then
			procd_knows "$s" || "$ROOT/etc/init.d/$s" start
		elif procd_knows "$s"; then
			"$ROOT/etc/init.d/$s" stop
		fi
	done < "$R/services" > /dev/null 2>&1
	# Once the network has settled on the restored devices: a reload keeps the
	# devices a service had (odhcpd kept sending to one the rollback removed).
	if [ -s "$R/restart" ]; then
		sleep 5
		while IFS= read -r s; do [ -x "$ROOT/etc/init.d/$s" ] && "$ROOT/etc/init.d/$s" restart; done < "$R/restart" > /dev/null 2>&1
	fi
	touch "$R/restored"
	# A reload is not proof the operator can reach the device: wait for them
	# to get back in and say so, else reboot (unless the mode forbids it).
	i=0; recover="$(cat "$R/recover")"
	while [ $i -lt "$recover" ]; do
		if [ -f "$R/recovered" ]; then say "revert restored access, no reboot needed"; cleanup; exit 0; fi
		sleep 1; i=$((i+1))
	done
	if [ "$mode" = reload ]; then
		say "revert did not restore access, but --rollback=reload forbids rebooting"
		cleanup; exit 1
	fi
	say "revert did not restore access in time, rebooting"
	sync
	reboot
}

# Confirmed: this device's settings are this app's, if this run committed
# them (a device the run never changed is left as it was). An image's
# first-boot defaults leave them alone after an upgrade that kept them: the
# marker says so, and sysupgrade keeps it by its keep.d list.
mark_applied() {
	[ -f "$R/committed" ] || [ -f "$R.committed" ] || return 0
	mkdir -p "$ROOT/etc/onc" "$ROOT/lib/upgrade/keep.d" && touch "$ROOT${appliedMarker}" &&
		echo "${appliedMarker}" > "$ROOT${appliedKeepList}"
}

# Its watchdog slept, and is gone without having started to restore (killed
# asleep: out of memory, say): nothing restores this run's change now.
died_asleep() { [ -f "$R/sleep.pid" ] && [ ! -f "$R/restoring" ] && ! is_watchdog "$p"; }

# Confirmed: this config is the one a restart must keep, so every run's
# boot-time copy goes (an earlier one reverted, say, whose watchdog has not
# woken yet), or a restart would restore it over this.
stood_down() { rm -rf "$BOOT_ROOT"; mark_applied; echo ONC_DISARMED; }

disarm() {
	if [ -f "$DISARMED" ]; then stood_down; return; fi
	p="$(cat "$R/${watchdogPidFile}" 2>/dev/null)"; s="$(cat "$R/sleep.pid" 2>/dev/null)"
	if died_asleep; then say "its watchdog had died before restoring anything: the change stays"; stood_down; return; fi
	is_watchdog "$p" || { echo ONC_FIRED; return; }
	touch "$R/confirmed"
	own_sleep "$s" "$p" && kill "$s" 2> /dev/null
	settle gone "$p"
	# Disarmed only on evidence: it still sleeps with the flag set (and stands
	# down when it wakes), or it said so as it stood down. Asked in that
	# order: one that exits between the two has written its marker first.
	if { is_watchdog "$p" && [ -f "$R/confirmed" ] && [ ! -f "$R/restoring" ]; } || [ -f "$DISARMED" ]; then
		stood_down
	else
		echo ONC_FIRED
	fi
}

# Before any device is disarmed, each is asked: still asleep, and how many
# seconds before it fires; or kept, its watchdog dead before restoring.
# Nothing else (restoring, restored, gone) means it fired.
asleep() {
	p="$(cat "$R/${watchdogPidFile}" 2>/dev/null)"; s="$(cat "$R/sleep.pid" 2>/dev/null)"
	if own_sleep "$s" "$p" && [ ! -f "$R/confirmed" ] && [ ! -f "$R/restoring" ]; then
		echo "ONC_ASLEEP $(( $(cat "$R/fires" 2>/dev/null || date +%s) - $(date +%s) ))"
	elif died_asleep; then
		echo ONC_KEPT
	fi
}

drop() {
	p="$(cat "$R/${watchdogPidFile}" 2>/dev/null)"; s="$(cat "$R/sleep.pid" 2>/dev/null)"
	if is_watchdog "$p"; then
		touch "$R/confirmed"
		own_sleep "$s" "$p" && kill "$s" 2> /dev/null
		# Still running (restoring, past the flag): its run is its own to finish.
		settle gone "$p" || { echo "onc-agent: its watchdog is still running" >&2; return 1; }
	fi
	rm -rf "$BOOT" "$R" "$W" "$DISARMED" "$R.committed" "$AGENT"
	echo ONC_DROPPED
}

# End the watchdog's wait, so it restores now: woken only if it was asleep,
# or already restoring. One that died asleep is started again with no wait.
rollback_now() {
	p="$(cat "$R/${watchdogPidFile}" 2>/dev/null)"; s="$(cat "$R/sleep.pid" 2>/dev/null)"
	if { own_sleep "$s" "$p" && kill "$s" 2> /dev/null; } || [ -f "$R/restoring" ]; then echo ONC_WOKEN; return; fi
	if died_asleep && [ ! -f "$R/confirmed" ]; then
		echo 0 > "$R/timeout" || return 1
		setsid sh "$AGENT" watchdog < /dev/null > /dev/null 2>&1 &
		echo ONC_WOKEN
	fi
}

leave_session_cgroup

case "$1" in
	begin) begin ;;
	revert) step "revert pending changes"; revert_pending >&2 && echo ONC_OK ;;
	prepare | stage | finalise | services | hooks) steps "$1" ;;
	stage-packages) shift; stage_packages "$@" ;;
	arm) shift; arm "$@" ;;
	watchdog) watchdog ;;
	commit-finished) [ -f "$R/committed" ] && echo ONC_COMMITTED ;;
	asleep) asleep ;;
	disarm) disarm ;;
	# The run is over here: its marker and agent go, and its directory unless
	# a watchdog still has it (one standing down removes it itself).
	done)
		p="$(cat "$R/${watchdogPidFile}" 2>/dev/null)"
		is_watchdog "$p" || rm -rf "$R"
		rm -rf "$W" "$DISARMED" "$R.committed" "$AGENT"; echo ONC_DONE ;;
	rollback-now) rollback_now ;;
	recovered) [ -f "$R/restored" ] && touch "$R/recovered" && echo ONC_RECOVERED ;;
	drop) drop ;;
	*) echo "onc-agent: unknown verb $1" >&2; exit 2 ;;
esac
`;
