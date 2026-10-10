// What a role, or a particular model, needs beyond the features. Model quirks
// are conditions on the model the device reports when it is provisioned, so
// the intent never names a model.
import { Feature, onAccessPoints, onModel } from "../fragment";

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
    ubihealthd: {
      "ubi-device": [
        {
          ".if": onModel("zyxel,nwa50ax-pro"),
          ".name": "ubi0",
          device: "/dev/ubi0",
        },
      ],
    },
  },
});
