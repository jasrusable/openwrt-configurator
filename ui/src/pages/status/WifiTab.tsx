// Status › Wi-Fi: each access point's radios as they run now (band, channel,
// width, power, noise floor, clients), and each SSID's reach.
import { Badge, Group } from "@mantine/core";
import type { Intent } from "../../../../src/intent/schema";
import { useNetworkStatus } from "../../data/status";
import { useDraftValue } from "../../form/draft";
import { EmptyState, Section, SettingRow, SettingsPage } from "../../kit/layout";
import { liveLine, Muted } from "./shared";

/** "HE80" as people say it: Wi-Fi 6, 80 MHz. */
const modeWords = (htmode?: string) => {
  const m = /^(EHT|HE|VHT|HT)(\d+)/.exec(htmode ?? "");
  if (!m) return undefined;
  const generation = { EHT: "Wi-Fi 7", HE: "Wi-Fi 6", VHT: "Wi-Fi 5", HT: "Wi-Fi 4" }[m[1]];
  return `${generation}, ${m[2]} MHz`;
};

export const WifiTab = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("wifi");
  const radios = status.data?.radios ?? [];
  const accessPoints = [...new Set(radios.map((r) => r.accessPoint))];
  return (
    <SettingsPage title="Wi-Fi" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      <Section title="Networks">
        {(status.data?.ssids ?? []).map((s) => (
          <SettingRow key={s.ssid} label={s.ssid} description={s.accessPoints.length ? `On ${s.accessPoints.join(", ")}` : "On no access point now"}>
            <Muted>{s.clients} connected</Muted>
          </SettingRow>
        ))}
      </Section>
      {accessPoints.length === 0 && (
        <Section>
          <EmptyState>{status.data ? "No access point is broadcasting." : "Reading the access points…"}</EmptyState>
        </Section>
      )}
      {accessPoints.map((ap) => (
        <Section key={ap} title={ap}>
          {radios
            .filter((r) => r.accessPoint === ap)
            .map((r) => (
              <SettingRow
                key={r.ifname}
                label={
                  <Group gap={8} wrap="nowrap">
                    {r.ssid ?? r.ifname}
                    {r.band && (
                      <Badge variant="light" color="blue" radius="sm" size="sm" style={{ textTransform: "none" }}>
                        {r.band}
                      </Badge>
                    )}
                  </Group>
                }
                description={[
                  r.channel !== undefined ? `Channel ${r.channel}` : undefined,
                  modeWords(r.htmode),
                  r.txpower !== undefined ? `${r.txpower} dBm power` : undefined,
                  r.noise !== undefined ? `noise ${r.noise} dBm` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <Muted>{r.clients} connected</Muted>
              </SettingRow>
            ))}
        </Section>
      ))}
    </SettingsPage>
  );
};
