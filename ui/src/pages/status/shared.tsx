// What the Status tabs share: when the devices were last read, what needs
// attention (with its fix or where to change it), and small readings.
import { Button, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import type { Attention } from "../../../../src/status/views";
import { useRestartService } from "../../data/status";
import { ago } from "../../facts";
import { Section, SettingRow } from "../../kit/layout";

/** "live, read from the devices 5 s ago", or that it is reading. */
export const liveLine = (site: string, updatedAt: number, fetching: boolean, has: boolean) =>
  has ? `${site} · live, read from the devices ${ago(updatedAt)}` : fetching ? `${site} · reading the devices…` : site;

const tone = { problem: "red", warning: "orange", info: "blue" } as const;
const icon = { problem: IconAlertTriangle, warning: IconAlertTriangle, info: IconInfoCircle } as const;

const AttentionRow = ({ item }: { item: Attention }) => {
  const navigate = useNavigate();
  const restart = useRestartService();
  const Icon = icon[item.severity];
  return (
    <SettingRow
      label={
        <Group gap={8} wrap="nowrap">
          <ThemeIcon variant="light" color={tone[item.severity]} radius="xl" size={22}>
            <Icon size={13} />
          </ThemeIcon>
          {item.title}
        </Group>
      }
      description={restart.isError ? (restart.error as Error).message : item.detail}
    >
      {item.fix ? (
        <Button
          size="xs"
          variant={item.severity === "problem" ? "filled" : "default"}
          loading={restart.isPending}
          disabled={restart.isSuccess}
          onClick={() => restart.mutate({ device: item.fix!.device, service: item.fix!.service })}
        >
          {restart.isSuccess ? "Done" : item.fix.label}
        </Button>
      ) : item.link ? (
        <Button size="xs" variant="default" onClick={() => navigate(item.link!)}>
          {item.link === "?apply" ? "Apply" : "Open"}
        </Button>
      ) : null}
    </SettingRow>
  );
};

/** What needs attention, worst first; a calm line when nothing does. */
export const AttentionSection = ({ items }: { items?: Attention[] }) =>
  items === undefined ? null : (
    <Section title="Needs attention">
      {items.length === 0 ? (
        <SettingRow
          label={
            <Group gap={8} wrap="nowrap">
              <ThemeIcon variant="light" color="green" radius="xl" size={22}>
                <IconCircleCheck size={13} />
              </ThemeIcon>
              All good
            </Group>
          }
          description="Every device answers, the internet works, and nothing else needs you."
        />
      ) : (
        items.map((item) => <AttentionRow key={item.id} item={item} />)
      )}
    </Section>
  );

/** Wi-Fi signal in words: what dBm means to a person. */
export const signalWords = (dbm?: number) =>
  dbm === undefined ? undefined : dbm >= -55 ? "excellent" : dbm >= -65 ? "good" : dbm >= -75 ? "fair" : "weak";

export const bytes = (n: number) =>
  n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;

export const Muted = ({ children }: { children: React.ReactNode }) => (
  <Text size="sm" c="dimmed" ta="right">
    {children}
  </Text>
);

export const Stacked = Stack;
