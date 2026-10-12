// What a role needs beyond the features. Fixes over OpenWrt are in patches/.
import { Feature, onAccessPoints } from "../fragment";

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
});
