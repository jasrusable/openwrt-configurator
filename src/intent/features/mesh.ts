// Wireless backhaul: the access points (and the router, where it has a radio
// in the mesh's band) link over Wi-Fi, so an access point needs no cable.
// 802.11s carries the links (SAE, no forwarding of its own) and batman-adv
// routes over them; bat0 joins each node's LAN bridge like a port, the main
// network untagged and the others tagged, and batman's bridge loop avoidance
// keeps a node that is also cabled from making a loop. As run at the
// Stellenberg site, plus the MTU: batman adds its header to every frame, so
// the mesh link carries 1532 bytes and nothing is fragmented.
import { Feature, onAccessPoints, onDevice, onRouter } from "../fragment";
import { fnv } from "./network";
import { radios } from "./wifi";
import { meshWiredVlan } from "../choices";
import type { Intent } from "../schema";

/** batman-adv's header, on top of a 1500-byte frame: the mesh link's MTU. */
export const meshMtu = 1532;

/** batman's cost of each hop, twice its default: a hop on one radio halves the speed, so prefer fewer. */
export const meshHopPenalty = 30;

/**
 * Weakest signal a mesh link may form at, dBm: a node does not pair with one
 * fainter (a flaky long hop batman would then route over). Stellenberg took 0
 * (no limit); -80 is the usual guidance for a usable 802.11s link.
 */
export const meshRssiThreshold = -80;

/**
 * batman-adv's routing: V chooses paths by each link's measured throughput
 * (ELP), where IV judges only by lost packets; better over mixed links (2.4 and
 * 5 GHz, cables). Stellenberg ran IV.
 */
export const meshRouting = "BATMAN_V";

/** The mesh's interface on each node: fixed, so its MTU can be set by name. */
export const meshInterface = "mesh0";

/** The mesh's name on the air, from the site: the same on every node, never typed. */
export const meshId = (intent: Pick<Intent, "site">) => `onc-${fnv(`${intent.site.name}/mesh`)}`;

/**
 * A repeater's rescue network: the address it has there, link-local and from
 * its name, so a laptop that got no address from DHCP (169.254.x.y, on its
 * own) reaches it with nothing else set up.
 */
export const rescueAddress = (name: string) => {
  const hash = fnv(`${name}/rescue`);
  return `169.254.${1 + (parseInt(hash.slice(0, 2), 16) % 254)}.${1 + (parseInt(hash.slice(2, 4), 16) % 254)}`;
};

/** Its rescue SSID: "<name> rescue", at most 32 characters. */
export const rescueSsid = (name: string) => `${name.slice(0, 25)} rescue`;

/** Minutes without hearing another node before the rescue network comes up. */
export const rescueAfterMinutes = 3;

const rescueScript = "/usr/libexec/onc/mesh-rescue";
const rescueService = "onc-mesh-rescue";

/** A node: any device with a radio in the mesh's band that can mesh (facts say which). */
export const meshNode = (intent: Pick<Intent, "mesh">) => `device.mesh_${intent.mesh.band} == true`;

export const mesh: Feature = (intent) => {
  const { enabled, band, channel, key } = intent.mesh;
  const node = meshNode(intent);
  const radio = radios.find((r) => r.band === band)!;
  const repeater = "device.tag.uplink == 'mesh'";
  // On 2.4 GHz, which reaches furthest.
  const rescueRadio = radios.find((r) => r.band === "2g")!.name;
  const repeaters = intent.hardware.filter((d) => d.role === "access-point" && d.uplink === "mesh");
  return {
    // A repeater that loses the mesh can only be reached by its rescue
    // network: a watcher brings it up after a while, as an uncommitted
    // change (a reboot or an apply starts with it off).
    ...(enabled && repeaters.length
      ? {
          services: [{ ".if": repeater, name: rescueService, running: true }],
          files: [
            {
              ".if": repeater,
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
	for p in /tmp/onc-watchdog-*.pid /tmp/.onc-provision-*.sh; do
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
              ".if": repeater,
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
    package_profiles: [
      { ".if": onAccessPoints, packages: ["kmod-batman-adv", "batctl-default"] },
      {
        ".if": `${onRouter} AND (device.wifi_2g == true OR device.wifi_5g == true OR device.wifi_6g == true)`,
        packages: ["kmod-batman-adv", "batctl-default", "-wpad-basic-mbedtls", "wpad-mbedtls"],
      },
    ],
    // Off: nothing declared, and the wipe leaves no batman interface.
    ...(enabled
      ? {
          config: {
            network: {
              interface: [
                {
                  ".if": node,
                  ".name": "bat0",
                  proto: "batadv",
                  routing_algo: meshRouting,
                  bridge_loop_avoidance: true,
                  distributed_arp_table: true,
                  hop_penalty: meshHopPenalty,
                  gw_mode: "off",
                },
                { ".if": node, ".name": "batmesh", proto: "batadv_hardif", master: "bat0" },
                // Each repeater's rescue network: its Wi-Fi alone, on its own
                // link-local address (no DHCP there).
                ...repeaters.map((d) => ({
                  ".if": onDevice(d.name),
                  ".name": "rescue",
                  proto: "static",
                  ipaddr: rescueAddress(d.name),
                  netmask: "255.255.0.0",
                })),
                ...(intent.mesh.wired
                  ? [
                      {
                        ".if": `${node} AND device.sw_config == false`,
                        ".name": "batwired",
                        proto: "batadv_hardif",
                        master: "bat0",
                        device: `br-lan.${meshWiredVlan}`,
                      },
                    ]
                  : []),
              ],
              device: [{ ".if": node, ".name": meshInterface, name: meshInterface, mtu: meshMtu }],
              // Over cables too: a VLAN of its own on every device's ports
              // (switched through those that are not nodes, the router
              // without Wi-Fi included), batman on it where there is one.
              // DSA nodes only: on a swconfig switch it is carried, not used.
              ...(intent.mesh.wired
                ? {
                    "bridge-vlan": [
                      {
                        ".if": "device.sw_config == false",
                        ".name": "vlan_mesh",
                        device: "br-lan",
                        vlan: meshWiredVlan,
                        // The physical ports alone: never the mesh's own bat0.
                        ports: ["*t"],
                      },
                    ],
                    switch_vlan: [
                      { ".if": "device.sw_config == true", ".name": "vlan_mesh", device: "switch0", vlan: meshWiredVlan, ports: "*t" },
                    ],
                  }
                : {}),
            },
            wireless: {
              // The router configures its radio only for the mesh: Wi-Fi for
              // devices is the access points' (features/wifi.ts sets theirs).
              "wifi-device": [
                {
                  ".if": `${onRouter} AND ${node}`,
                  ".name": radio.name,
                  band,
                  channel,
                  htmode: `@best/${band === "2g" ? 20 : 80}`,
                  country: intent.site.country,
                },
              ],
              "wifi-iface": [
                {
                  ".if": node,
                  ".name": "mesh",
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
                },
                // Off until the watcher turns it on; its key is the mesh's,
                // so WPA3 (SAE) as the mesh has it: under WPA2 a captured
                // handshake would expose the mesh's key to offline guessing.
                ...repeaters.map((d) => ({
                  ".if": onDevice(d.name),
                  ".name": "rescue",
                  device: [rescueRadio],
                  mode: "ap",
                  ifname: "rescue0",
                  ssid: rescueSsid(d.name),
                  encryption: "sae",
                  key,
                  network: "rescue",
                  disabled: true,
                })),
              ],
            },
          },
        }
      : {}),
  };
};
