#!/bin/sh
# The router's intent (/etc/onc/intent.json) is the source of truth; a Mac
# works on a copy. Pull before working, push what you changed. Each side refuses
# to overwrite what the other changed since the last pull (by hash, never by
# printing content), unless --force.
#
# Usage: scripts/router-intent.sh pull|push <host> <local-intent> [--force]
#
# <local-intent>.router holds the router file's hash as last pulled or pushed.
# A push keeps the router's previous file as /etc/onc/intent.json.<time>.bak.
set -eu

usage="usage: scripts/router-intent.sh pull|push <host> <local-intent> [--force]"
action=${1:?$usage}
host=${2:?$usage}
local=${3:?$usage}
force=${4:-}
remote=/etc/onc/intent.json
base_file=$local.router

local_hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
remote_hash() { ssh "root@$host" "sha256sum $remote" 2>/dev/null | grep -o '^[0-9a-f]\{64\}'; }
base=$(cat "$base_file" 2>/dev/null || true)

case $action in
  pull)
    # Local edits made since the last pull or push would be lost.
    if [ -f "$local" ] && [ -z "$force" ] && [ "$(local_hash "$local")" != "$base" ] && [ "$(local_hash "$local")" != "$(remote_hash)" ]; then
      echo "$local has changes not pushed to $host (push them, or --force to drop them)." >&2
      exit 1
    fi
    tmp=$local.pull.$$
    (umask 077 && ssh "root@$host" "cat $remote" >"$tmp")
    [ -s "$tmp" ] || { rm -f "$tmp"; echo "Read nothing from $host:$remote." >&2; exit 1; }
    mv "$tmp" "$local"
    local_hash "$local" >"$base_file"
    echo "Pulled $host:$remote into $local."
    ;;
  push)
    [ -f "$local" ] || { echo "No $local." >&2; exit 1; }
    now=$(remote_hash)
    if [ -z "$force" ] && [ "$now" != "$base" ]; then
      echo "$host:$remote changed since the last pull (pull first, or --force to overwrite it)." >&2
      exit 1
    fi
    [ "$(local_hash "$local")" = "$now" ] && { echo "Nothing to push: $host has the same file."; exit 0; }
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    ssh "root@$host" "umask 077 && cat > $remote.new && { [ ! -e $remote ] || cp -p $remote $remote.$stamp.bak; } && mv $remote.new $remote" <"$local"
    [ "$(remote_hash)" = "$(local_hash "$local")" ] || { echo "Push did not land on $host." >&2; exit 1; }
    local_hash "$local" >"$base_file"
    echo "Pushed $local to $host:$remote (previous kept as $remote.$stamp.bak)."
    ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
