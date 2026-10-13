// Device discovery across networks: avahi reflects mDNS (AirPlay, printers,
// Chromecast, HomeKit) between the networks that share their devices, so an
// isolated IoT network's speaker still shows up at home. avahi reads a file,
// not UCI; it is always installed on the router, and with fewer than two
// networks sharing it only answers for the router, on the main network.
import { Feature, mainNetwork, onRouter } from "../fragment";
import { deviceOf } from "./compile";

export const discovery: Feature = (intent) => {
  const sharing = intent.networks.filter((n) => n.share_devices);
  const reflect = sharing.length >= 2;
  // Never WAN: avahi answers on every interface unless told which.
  const interfaces = (reflect ? sharing : [mainNetwork(intent)]).map(deviceOf);
  return {
    packages: [{ when: onRouter, add: ["avahi-nodbus-daemon"] }],
    services: [{ when: onRouter, name: "avahi-daemon", running: true }],
    files: [
      {
        when: onRouter,
        path: "/etc/avahi/avahi-daemon.conf",
        content: [
          "[server]",
          "use-ipv4=yes",
          "use-ipv6=yes",
          "check-response-ttl=no",
          "use-iff-running=no",
          `allow-interfaces=${interfaces.join(",")}`,
          "",
          "[publish]",
          "publish-addresses=yes",
          "publish-hinfo=no",
          "publish-workstation=no",
          "publish-domain=yes",
          "",
          "[reflector]",
          `enable-reflector=${reflect ? "yes" : "no"}`,
          "reflect-ipv=no",
          "",
          "[rlimits]",
          "rlimit-core=0",
          "rlimit-data=4194304",
          "rlimit-fsize=0",
          "rlimit-nofile=30",
          "rlimit-stack=4194304",
          "rlimit-nproc=3",
          "",
        ].join("\n"),
        // Its reload only signals; a changed file needs a restart.
        runAfter: "/etc/init.d/avahi-daemon restart",
      },
    ],
  };
};
