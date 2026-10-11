// What a role needs beyond the features. Fixes over OpenWrt are in patches/.
import { everyDevice, Feature, onAccessPoints } from "../fragment";

export const roles: Feature = () => ({
  package_profiles: [
    {
      // An access point routes nothing: no firewall, DHCP/DNS or PPPoE.
      ".if": onAccessPoints,
      packages: ["-firewall4", "-dnsmasq", "-odhcpd-ipv6only", "-ppp-mod-pppoe"],
    },
  ],
  config: {
    // Shipped by the full wpad; no RADIUS server is wanted.
    radius: { radius: [{ ".if": onAccessPoints, disabled: true }] },
  },
  // UBI flash health: ubihealthd's own first-boot script sets up a section
  // for each UBI device the hardware has, so keep what it made, wherever it
  // made one ("?": devices without UBI flash have no such config).
  configs_to_not_reset: [{ ".if": everyDevice, configs: ["?ubihealthd.*"] }],
});
