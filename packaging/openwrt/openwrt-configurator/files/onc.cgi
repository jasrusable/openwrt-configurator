#!/bin/sh
# The web UI, answered by uhttpd at /cgi-bin/onc/: log in with the router's
# root password (src/server/auth.ts). The settings live in /etc/onc/intent.json.
exec qjs --module /usr/share/openwrt-configurator/openwrt-configurator.mjs \
  cgi /etc/onc/intent.json --ui-dir /usr/share/openwrt-configurator/ui
