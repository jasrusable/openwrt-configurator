import { Patch } from "./patch";

export const r6sPacketSteering: Patch = {
  id: "r6s-packet-steering",
  why:
    "OpenWrt's generic packet steering put WAN receive work on a little A55 core, " +
    "which hit ~100% softirq at ~600 Mbit/s; this board script spreads it over big cores " +
    "(43% on the busiest at the same load).",
  target: { models: ["friendlyarm,nanopi-r6s"] },
  apply: () => ({
    files: [
      {
        path: "/usr/libexec/platform/packet-steering.sh",
        mode: "0755",
        content: `#!/bin/sh
# Board RPS for the NanoPi R6S. /etc/init.d/packet_steering runs this instead
# of the generic packet-steering.uc whenever it exists, on every interface event.
#
# The generic logic picks the least-loaded CPU with no regard for capacity and
# steered WAN RX to little core CPU2 (an A55, capacity 397 vs 1024), which hit
# ~100% softirq forwarding ~600 Mbit/s. Board IRQs are pinned by
# /etc/hotplug.d/net/40-net-smp-affinity (eth0 CPU4, eth1 CPU5, eth2 CPU6), so
# send each port's RPS to a different big core: measured 43% on the busiest
# core at the same load. packet_steering=0 still disables RPS outright.
set_rps() {
	for q in /sys/class/net/$1/queues/rx-*/rps_cpus; do
		[ -e "$q" ] && echo "$2" > "$q"
	done
}

if [ "$1" = 0 ]; then
	for dev in eth0 eth1 eth2; do set_rps $dev 0; done
	exit 0
fi

set_rps eth1 80 # WAN: IRQ on CPU5, RPS to CPU7
set_rps eth2 10 # LAN: IRQ on CPU6, RPS to CPU4
set_rps eth0 0  # unused 1G port: stay on its IRQ core
`,
        // When the file changed: packet_steering runs it on every interface event anyway.
        runAfter: "/etc/init.d/packet_steering reload",
      },
    ],
  }),
};
