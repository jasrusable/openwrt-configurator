// What the Status tabs share: when the devices were last read, what needs
// attention (with its fix or where to change it), and small readings.
import { Badge, Button, Group, Text, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from "@tabler/icons-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { NetworkStatus } from "../../../../src/status/network";
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
  // Each read brings the item anew: "Done" lasts until then, and if it is
  // still there the button is offered again.
  useEffect(() => restart.reset(), [item]); // eslint-disable-line react-hooks/exhaustive-deps
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

type LiveConnection = NetworkStatus["connections"][number];

/**
 * An internet line as the pages say it: whether it works (mwan3's view with
 * several lines, else its interface), for how long, and in a word.
 */
export const lineState = (now: LiveConnection | undefined, several: boolean) => {
  const works = now?.line ? ["online", "disconnecting"].includes(now.line.state) : now?.up;
  const since = now?.line?.since ?? (now?.up ? now.uptime : undefined);
  const word = !now
    ? undefined
    : now.inUse
      ? several
        ? "In use"
        : "Connected"
      : works
        ? "Standby"
        : now.line?.state === "connecting"
          ? "Coming back"
          : "Down";
  return { works, since, word, dot: now ? (now.inUse ? true : works ? undefined : false) : undefined };
};

/** Each band's own colour, the same on every page. */
export const bandColor = (band?: string) => (band === "6 GHz" ? "grape" : band === "5 GHz" ? "blue" : "teal");

export const BandBadge = ({ band }: { band?: string }) =>
  band ? (
    <Badge variant="light" color={bandColor(band)} radius="sm" size="sm" style={{ textTransform: "none" }}>
      {band}
    </Badge>
  ) : null;

export const Muted = ({ children }: { children: React.ReactNode }) => (
  <Text size="sm" c="dimmed" ta="right">
    {children}
  </Text>
);
