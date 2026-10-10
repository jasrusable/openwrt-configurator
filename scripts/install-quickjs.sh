#!/bin/sh
# Build and install `qjs` at exactly the version OpenWrt 25.12 ships, so the
# parity test exercises the engine that will run on devices. Version and hash
# are taken from the openwrt-25.12 branch of openwrt/packages (lang/quickjs).
#
# Usage: scripts/install-quickjs.sh <prefix>   (installs <prefix>/bin/qjs)
set -eu

prefix=$1
version=2025-09-13
tarball=quickjs-$version-2.tar.xz
sha256=996c6b5018fc955ad4d06426d0e9cb713685a00c825aa5c0418bd53f7df8b0b4

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://bellard.org/quickjs/$tarball" -o "$work/$tarball"
echo "$sha256  $work/$tarball" | sha256sum -c - >/dev/null
tar -xJf "$work/$tarball" -C "$work"
make -C "$work/quickjs-$version" -j"$(nproc 2>/dev/null || echo 2)" qjs >/dev/null
mkdir -p "$prefix/bin"
cp "$work/quickjs-$version/qjs" "$prefix/bin/"
"$prefix/bin/qjs" -e 'print("qjs installed")'
