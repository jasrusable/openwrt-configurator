import { Text } from "@mantine/core";
import { ZoneMatrix } from "../../firewall/ZoneMatrix";
import { SettingsPage } from "../../kit/layout";

export const FirewallOverviewPage = () => (
  <SettingsPage
    title="Firewall"
    description="Which zone may reach which. Click a cell between two zones to allow or block it; the router column and the diagonal are set on each zone."
    wide
  >
    <ZoneMatrix />
    <Text size="xs" c="dimmed" px={4}>
      Allow is a zone forwarding. Rules (counted in a cell) refine any pair,
      and port forwards let chosen traffic in from WAN.
    </Text>
  </SettingsPage>
);
