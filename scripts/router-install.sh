#!/bin/sh
# Build this checkout as the OpenWrt package and install it on a device with
# apk, as a user would run it: for trying the router-hosted app for real.
#
# Usage: scripts/router-install.sh <host> [--intent <file>] [--replace-intent]
#   <host>            what ssh connects to as root (an address or an ssh alias)
#   --intent <file>   copy this intent to /etc/onc/intent.json (0600), only if
#                     none is there: the router's copy is live once edited there
#   --replace-intent  overwrite the router's intent with --intent's
#
# Each build gets its own version (<package.json version>_p<timestamp>), so every
# install is an upgrade. Signed with the SDK's throwaway key, so it is installed
# --allow-untrusted. quickjs comes from the device's own feeds. Remove with
# `apk del openwrt-configurator`. The UI is then at http://<host>/cgi-bin/onc/.
set -eu

host=${1:?usage: scripts/router-install.sh <host> [--intent <file>] [--replace-intent]}
shift
intent=
replace=
while [ $# -gt 0 ]; do
  case $1 in
    --intent) intent=${2:?--intent needs a file}; shift 2 ;;
    --replace-intent) replace=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -z "$intent" ] || [ -f "$intent" ] || { echo "No intent at $intent" >&2; exit 1; }

root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/artifacts/apk-dev
version=$(node -p 'require(process.argv[1]).version' "$root/package.json")_p$(date +%Y%m%d%H%M%S)

cd "$root"
npm run bundle
node scripts/build-ui.js
rm -rf "$out"
packaging/openwrt/build.sh "$version" "$out"
apk=$(ls "$out"/openwrt-configurator-*.apk)

# Through ssh's own channel: dropbear has no sftp-server, which newer scp needs.
ssh "root@$host" 'cat > /tmp/onc-dev.apk' <"$apk"
ssh "root@$host" 'apk add --allow-untrusted /tmp/onc-dev.apk; rc=$?; rm -f /tmp/onc-dev.apk; exit $rc'

if [ -n "$intent" ]; then
  ssh "root@$host" "[ -z '$replace' ] && [ -e /etc/onc/intent.json ] && { echo 'Kept the router'\''s /etc/onc/intent.json (--replace-intent to overwrite).' >&2; exit 0; }
    umask 077 && cat > /etc/onc/intent.json.new && mv /etc/onc/intent.json.new /etc/onc/intent.json" <"$intent"
fi

# The collector compiles the settings it reads; a new build should read with new code.
ssh "root@$host" '/etc/init.d/onc-collector restart'
echo "Installed openwrt-configurator $version on $host: http://$host/cgi-bin/onc/"
