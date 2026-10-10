#!/bin/sh
# Build the openwrt-configurator apk and a signed feed index in the official
# OpenWrt SDK. The package is architecture-independent, so one SDK serves
# every device.
#
# Usage: packaging/openwrt/build.sh <version> <out-dir> [private-key.pem]
#   Run `npm run bundle` first. Without a key the SDK generates a throwaway
#   one, which is only good for testing: devices trust a feed by its key.
set -eu

version=$1
out=$2
key=${3:-}
sdk=openwrt/sdk:x86-64-v25.12.5
root=$(cd "$(dirname "$0")/../.." && pwd)
pkg=$root/packaging/openwrt/openwrt-configurator

bundle=$root/dist/qjs/openwrt-configurator.mjs
[ -f "$bundle" ] || { echo "No bundle at $bundle; run npm run bundle." >&2; exit 1; }
cp "$bundle" "$pkg/files/"
mkdir -p "$out"
out=$(cd "$out" && pwd)
# The SDK runs as its own user, which must be able to write here.
chmod a+rwx "$out"

# The key goes in on stdin: a 0600 file mounted from the host is unreadable to
# the SDK's user on Linux, and stdin keeps it out of mounts and the environment.
if [ -n "$key" ]; then exec <"$key"; else exec </dev/null; fi

docker run --rm -i --platform linux/amd64 \
  -v "$pkg:/builder/package/openwrt-configurator:ro" \
  -v "$out:/out" \
  -e VERSION="$version" \
  -e HAVE_KEY="${key:+1}" \
  "$sdk" sh -euc '
    if [ -n "$HAVE_KEY" ]; then (umask 077 && cat >private-key.pem); fi
    make defconfig >/dev/null
    make package/openwrt-configurator/compile PKG_VERSION="$VERSION" >/tmp/build.log 2>&1 \
      || { tail -40 /tmp/build.log; exit 1; }
    make package/index >/tmp/index.log 2>&1 || { tail -40 /tmp/index.log; exit 1; }
    dir=$(dirname "$(find bin/packages -name "openwrt-configurator-*.apk" | head -1)")
    cp "$dir"/openwrt-configurator-*.apk "$dir"/packages.adb public-key.pem /out/
    [ -f "$dir/index.json" ] && cp "$dir/index.json" /out/ || true
  '
ls -l "$out"
