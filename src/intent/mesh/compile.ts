// Wireless backhaul: the access points (and the router, where it has a radio
// in the mesh's band) link over Wi-Fi, so an access point needs no cable.
// 802.11s carries the links (SAE, no forwarding of its own) and batman-adv
// routes over them; bat0 joins each node's LAN bridge like a port, the main
// network untagged and the others tagged, and batman's bridge loop avoidance
// keeps a node that is also cabled from making a loop. As run at the
// Stellenberg site, plus the MTU: batman adds its header to every frame, so
// the mesh link carries 1532 bytes and nothing is fragmented.
import { Feature, onAccessPoints, onDevice, onDsa, onRouter, onSwConfig } from "../fragment";
import { placeholder, section } from "../../plan/types";
import { when } from "../../plan/when";
import { meshWiredVlan, radios, radioWidth } from "../radios";
import type { Intent } from "../schema";
import { meshHopPenalty, meshId, meshInterface, meshMtu, meshRouting, meshRssiThreshold, rescueAddress, rescueAfterMinutes, rescueSsid } from "./constants";
import { agentGlob, watchdogPidGlob } from "../../agent/paths";

const rescueScript = "/usr/libexec/onc/mesh-rescue";
const rescueService = "onc-mesh-rescue";

/** A node: any device with a radio in the mesh's band that can mesh (facts say which). */
export const meshNode = (intent: Pick<Intent, "wifi">) => when.meshRadio(intent.wifi.mesh.band);

export const mesh: Feature = (intent) => {
  const { enabled, band, channel, key } = intent.wifi.mesh;
  const node = meshNode(intent);
  const radio = radios.find((r) => r.band === band)!;
  const repeater = when.tag("uplink", "mesh");
  // On 2.4 GHz, which reaches furthest.
  const rescueRadio = radios.find((r) => r.band === "2g")!.name;
  const repeaters = intent.hardware.filter((d) => d.role === "access-point" && d.uplink === "mesh");
  return {
    // A repeater that loses the mesh can only be reached by its rescue
    // network: a watcher brings it up after a while, as an uncommitted
    // change (a reboot or an apply starts with it off).
    ...(enabled && repeaters.length
      ? {
          services: [{ when: repeater, name: rescueService, running: true }],
          files: [
            {
              when: repeater,
              path: rescueScript,
              mode: "0755",
              content: `#!/bin/sh
# This access point's rescue Wi-Fi: up once it has heard no other mesh node
# for ${rescueAfterMinutes} minutes, so it can still be reached without a cable; down again
# when the mesh is back. A uci change never committed: a reboot or an apply
# starts with it off. It stands aside while an apply runs.
command -v batctl >/dev/null || exit 0
rescue() { uci -q show wireless | grep "ifname='rescue0'$" | cut -d . -f 2 | head -n 1; }
applying() {
	for p in ${watchdogPidGlob} ${agentGlob}; do
		[ -f "$p" ] || continue
		case "$p" in *.pid) kill -0 "$(cat "$p")" 2>/dev/null && return 0 ;; *) return 0 ;; esac
	done
	return 1
}
# What this watcher turned on, not what uci says: a change it did not make
# (an apply's, a commit) is never acted on, so it cannot restart Wi-Fi in a loop.
on=0
quiet=0
while sleep 30; do
	section=$(rescue)
	# No longer a repeater (its rescue network is gone): nothing to watch.
	[ -n "$section" ] || exit 0
	applying && continue
	if batctl meshif bat0 originators -H 2>/dev/null | grep -q .; then
		quiet=0
		if [ "$on" = 1 ]; then
			on=0
			uci -q revert "wireless.$section"
			uci -q revert "wireless.$radio"
			logger -t onc-mesh "mesh back: rescue Wi-Fi off"
			wifi up
		fi
	else
		quiet=$((quiet + 1))
		if [ "$on" = 0 ] && [ "$quiet" -ge ${rescueAfterMinutes * 2} ]; then
			# Its radio too: 2.4 GHz may be off for everything else.
			radio=$(uci -q get "wireless.$section.device") || continue
			uci set "wireless.$section.disabled=0" && uci set "wireless.$radio.disabled=0" || continue
			on=1
			logger -t onc-mesh "no mesh for ${rescueAfterMinutes} minutes: rescue Wi-Fi on"
			wifi up
		fi
	fi
done
`,
            },
            {
              when: repeater,
              path: `/etc/init.d/${rescueService}`,
              mode: "0755",
              content: `#!/bin/sh /etc/rc.common
# The mesh rescue watcher (${rescueScript}), kept running by procd.
START=99
USE_PROCD=1

start_service() {
	procd_open_instance
	procd_set_param command ${rescueScript}
	procd_set_param respawn
	procd_close_instance
}
`,
            },
          ],
        }
      : {}),
    // Installed whether on or not, where a node could be: every access
    // point, and a router with Wi-Fi (which also needs the full wpad, for SAE).
    // On every device that could be a node, mesh on or off, as every
    // feature's packages are (about 0.4 MiB; the full wpad, which access
    // points have anyway, 0.8 MiB more on a router): turning it on is then a
    // config change, and a repeater never installs over the link it changes.
    packages: [
      { when: onAccessPoints, add: ["kmod-batman-adv", "batctl-default"] },
      {
        when: when.all(onRouter, when.any(when.radio("2g"), when.radio("5g"), when.radio("6g"))),
        add: ["kmod-batman-adv", "batctl-default", "wpad-mbedtls"],
        remove: ["wpad-basic-mbedtls"],
      },
    ],
    // Off: nothing declared, and the wipe leaves no batman interface.
    ...(enabled
      ? {
          config: {
            network: {
              interface: [
                section(
                  { name: "bat0", when: node },
                  {
                    proto: "batadv",
                    routing_algo: meshRouting,
                    bridge_loop_avoidance: true,
                    distributed_arp_table: true,
                    hop_penalty: meshHopPenalty,
                    gw_mode: "off",
                  }
                ),
                section({ name: "batmesh", when: node }, { proto: "batadv_hardif", master: "bat0" }),
                // Each repeater's rescue network: its Wi-Fi alone, on its own
                // link-local address (no DHCP there).
                ...repeaters.map((d) =>
                  section({ name: "rescue", when: onDevice(d.name) }, { proto: "static", ipaddr: rescueAddress(d.name), netmask: "255.255.0.0" })
                ),
                ...(intent.wifi.mesh.over_cable
                  ? [
                      section(
                        { name: "batwired", when: when.all(node, onDsa) },
                        { proto: "batadv_hardif", master: "bat0", device: `br-lan.${meshWiredVlan}` }
                      ),
                    ]
                  : []),
              ],
              device: [
                section({ name: meshInterface, when: node }, { name: meshInterface, mtu: meshMtu }),
                // Over cables, on every DSA device (the router switches it
                // too): its ports and VLAN take batman's frames whole. A port
                // that cannot keeps 1500 and batman fragments there; status says so.
                ...(intent.wifi.mesh.over_cable && intent.wifi.mesh.large_frames
                  ? [
                      section({ name: "meshport", when: onDsa }, { name: placeholder.eachBridgePort, mtu: meshMtu }),
                      section({ name: "meshwired", when: onDsa }, { name: `br-lan.${meshWiredVlan}`, mtu: meshMtu }),
                    ]
                  : []),
              ],
              // Over cables too: a VLAN of its own on every device's ports
              // (switched through those that are not nodes, the router
              // without Wi-Fi included), batman on it where there is one.
              // DSA nodes only: on a swconfig switch it is carried, not used.
              ...(intent.wifi.mesh.over_cable
                ? {
                    "bridge-vlan": [
                      section(
                        { name: "vlan_mesh", when: onDsa },
                        // The physical ports alone: never the mesh's own bat0.
                        { device: "br-lan", vlan: meshWiredVlan, ports: [placeholder.freePortsTagged] }
                      ),
                    ],
                    switch_vlan: [
                      section(
                        { name: "vlan_mesh", when: onSwConfig },
                        { device: "switch0", vlan: meshWiredVlan, ports: placeholder.freePortsTagged }
                      ),
                    ],
                  }
                : {}),
            },
            wireless: {
              // The router configures its radio only for the mesh: Wi-Fi for
              // devices is the access points' (wifi/compile.ts sets theirs).
              "wifi-device": [
                section(
                  { name: radio.name, when: when.all(onRouter, node) },
                  { band, channel, htmode: placeholder.bestMode(Number(radioWidth(intent, band))), country: intent.system.country }
                ),
              ],
              "wifi-iface": [
                section({ name: "mesh", when: node }, {
                  device: [radio.name],
                  mode: "mesh",
                  ifname: meshInterface,
                  mesh_id: meshId(intent),
                  encryption: "sae",
                  key,
                  // batman routes; 802.11s only links.
                  mesh_fwding: false,
                  mesh_rssi_threshold: meshRssiThreshold,
                  network: "batmesh",
                }),
                // Off until the watcher turns it on; its key is the mesh's,
                // so WPA3 (SAE) as the mesh has it: under WPA2 a captured
                // handshake would expose the mesh's key to offline guessing.
                ...repeaters.map((d) =>
                  section({ name: "rescue", when: onDevice(d.name) }, {
                  device: [rescueRadio],
                  mode: "ap",
                  ifname: "rescue0",
                  ssid: rescueSsid(d.name),
                  encryption: "sae",
                  key,
                  network: "rescue",
                  disabled: true,
                  })
                ),
              ],
            },
            // SSH on the rescue network too: the main one's address goes with
            // the mesh, and this app (and a person) logs in over SSH. Same
            // rules as the main instance (system/compile.ts).
            dropbear: {
              dropbear: repeaters.map((d) =>
                section({ name: "rescue", when: onDevice(d.name) }, {
                PasswordAuth: intent.system.ssh.password_login ? "on" : "off",
                RootPasswordAuth: intent.system.ssh.password_login ? "on" : "off",
                Port: 22,
                Interface: "rescue",
                })
              ),
            },
          },
        }
      : {}),
  };
};
