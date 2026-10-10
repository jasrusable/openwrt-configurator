#!/bin/sh
# Render the Homebrew formula for one release.
# Usage: packaging/homebrew/render.sh <version> <bundle-url> <bundle-file>
set -eu
version=$1
url=$2
sha=$(shasum -a 256 "$3" 2>/dev/null || sha256sum "$3")
sed -e "s|@VERSION@|$version|" -e "s|@URL@|$url|" -e "s|@SHA256@|${sha%% *}|" \
  "$(dirname "$0")/openwrt-configurator.rb.in"
