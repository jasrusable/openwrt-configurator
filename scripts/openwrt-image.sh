# Sourced by the Docker tests (rig-test.sh, mwan3-test.sh): which OpenWrt
# image to boot, and how. Sets version, image, platform (for docker run),
# pull_platform and node_platform, and pulls the image if it is not here.
#
# ONC_RIG_VERSION: a 25.12 point release (25.12.0, 25.12.6, ...) or SNAPSHOT;
# CI runs several (.github/workflows/test.yml).
version=${ONC_RIG_VERSION:-25.12.6}
case $version in
  SNAPSHOT) tag=SNAPSHOT ;;
  *) tag=v$version ;;
esac
case "$(uname -m)" in
  # The arm64 rootfs is labelled linux/aarch64_generic, which no --platform
  # matches, so it runs with none; the node image is a normal multi-arch one.
  arm64 | aarch64) image=openwrt/rootfs:armsr-armv8-$tag platform='' pull_platform=linux/aarch64_generic node_platform=linux/arm64 ;;
  *) image=openwrt/rootfs:x86-64-$tag platform=linux/amd64 pull_platform=linux/amd64 node_platform=linux/amd64 ;;
esac
# Pulled by its own label first: `docker run` alone looks for linux/arm64,
# which the arm64 rootfs does not claim, and fails on an image not yet here.
docker image inspect "$image" >/dev/null 2>&1 ||
  docker pull --platform "$pull_platform" "$image" >/dev/null

# A booted container's logd reads /proc/kmsg, which no container has its own
# of: with several booted, one logd's read takes a message another was woken
# for, which then blocks in read() for good. Its /dev/log fills, every
# syslog() caller blocks (dropbear at each connection), and SSH hangs: the
# rig's intermittent stall. A real router has one logd. So each container's
# logd reads a FIFO no one writes instead; logger and logread still work.
# (--cap-drop SYSLOG does not help: --privileged keeps every capability.)
quiet_kmsg() {
  docker exec "$1" sh -c 'mkfifo /var/kmsg.none && mount --bind /var/kmsg.none /proc/kmsg && /etc/init.d/log restart' >/dev/null 2>&1
}
