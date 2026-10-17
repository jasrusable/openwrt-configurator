// What the Status pages share: when the devices were last read, what needs
// attention (with its fix or where to change it), a line's state, a
// client's kind and name, and the events about one thing.
import { Button, Group, SegmentedControl, ThemeIcon } from "@mantine/core";
import {
  IconAccessPoint,
  IconAlertTriangle,
  IconBulb,
  IconCamera,
  IconDeviceDesktop,
  IconDeviceGamepad2,
  IconDeviceLaptop,
  IconDeviceMobile,
  IconDeviceSpeaker,
  IconDeviceTablet,
  IconDeviceTv,
  IconDeviceWatch,
  IconDevices,
  IconInfoCircle,
  IconPrinter,
  IconRouter,
} from "@tabler/icons-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { ClientKind } from "../../../../src/status/clientKind";
import type { NetworkEvent } from "../../../../src/status/events";
import type { Tone } from "../../../../src/status/health";
import type { NetworkStatus } from "../../../../src/status/network";
import type { Intent } from "../../../../src/intent/schema";
import type { Attention, ClientView, DeviceView } from "../../../../src/status/views";
import { useRangeSwitch } from "../../data/history";
import { useRestartService } from "../../data/status";
import { ago, duration } from "../../facts";
import { SettingRow } from "../../kit/layout";

/** A status read, as a page has it from React Query. */
type Read = { data?: unknown; dataUpdatedAt: number; isFetching: boolean; error: unknown };

const failure = (read: Read) =>
  read.error && !read.isFetching ? `could not read the devices: ${(read.error as Error).message ?? read.error}` : undefined;

/** "live, read from the devices 5 s ago", that it is reading, or why it could not. */
export const liveLine = (read: Read) => {
  const failed = failure(read);
  // When the server read it (its collector may have read it a little before this page asked).
  const status = read.data as NetworkStatus | undefined;
  const at = status?.readAt ?? read.dataUpdatedAt;
  const when = read.data ? `read from the devices ${ago(at)}` : undefined;
  if (failed) return `${failed[0].toUpperCase()}${failed.slice(1)}${when ? `; showing what was ${when}` : ""}`;
  if (status?.applying) return `Settings are being applied; showing what was ${when}`;
  return when ? `Live, ${when}` : read.isFetching ? "Reading the devices…" : undefined;
};

/** An empty list's words while nothing is read: `reading`, or why it could not be. */
export const unread = (read: Read, reading: string) => {
  const failed = failure(read);
  return failed ? `${failed[0].toUpperCase()}${failed.slice(1)}.` : reading;
};

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

/** What needs attention, worst first, each with its fix or where to go. */
export const AttentionRows = ({ items }: { items: Attention[] }) => (
  <div className="onc-card onc-rows">
    {items.map((item) => (
      <AttentionRow key={item.id} item={item} />
    ))}
  </div>
);

type LiveConnection = NetworkStatus["connections"][number];

/**
 * An internet line as the pages say it: whether it works (mwan3's view with
 * several lines, else its interface), for how long, in a word, and its tone:
 * carrying traffic or ready to is good, coming back fair, down poor.
 */
export const lineState = (now: LiveConnection | undefined, several: boolean): { works?: boolean; since?: number; word?: string; tone: Tone } => {
  if (!now || now.up === undefined) return { tone: "off" };
  const works = now.line ? ["online", "disconnecting"].includes(now.line.state) : now.up;
  const since = now.line?.since ?? (now.up ? now.uptime : undefined);
  const word = now.inUse ? (several ? "In use" : "Connected") : works ? "Standby" : now.line?.state === "connecting" ? "Coming back" : "Down";
  return { works, since, word, tone: works ? "good" : now.line?.state === "connecting" ? "fair" : "poor" };
};

/** Each kind's icon, in one quiet colour: colour on these pages says how something is, never what it is. */
const kindIcons: Record<ClientKind, typeof IconDevices> = {
  phone: IconDeviceMobile,
  tablet: IconDeviceTablet,
  watch: IconDeviceWatch,
  laptop: IconDeviceLaptop,
  computer: IconDeviceDesktop,
  tv: IconDeviceTv,
  speaker: IconDeviceSpeaker,
  printer: IconPrinter,
  camera: IconCamera,
  console: IconDeviceGamepad2,
  iot: IconBulb,
};

export const kindIcon = (kind?: ClientKind) => (kind ? kindIcons[kind] : IconDevices);
export const roleIcon = (role: string) => (role === "router" ? IconRouter : IconAccessPoint);

/** A thing's icon before its name: grey while it is not here. */
export const ThingIcon = ({ icon: Icon, away = false }: { icon: typeof IconDevices; away?: boolean }) => (
  <ThemeIcon size={28} radius={8} variant="light" color="gray" style={{ opacity: away ? 0.55 : 1, flexShrink: 0 }} aria-hidden>
    <Icon size={16} stroke={1.8} />
  </ThemeIcon>
);

/** A client's name: yours, what it says, what it gave DHCP, else its MAC. */
export const clientName = (c: Pick<ClientView, "name" | "mac">) => c.name ?? c.mac;

/** How a client is connected, in a few words: "Loft · 5 GHz · Home", "Cable". */
export const connectionWords = (c: ClientView) =>
  c.connection.kind === "wifi"
    ? [c.connection.accessPoint, c.connection.band, c.connection.ssid].filter(Boolean).join(" · ")
    : c.connection.kind === "wired"
      ? "Cable"
      : c.state === "away"
        ? "Away"
        : "Not seen lately";

/** The events about one thing ("device:loft", "client:aa:…"), or any of several. */
export const eventsAbout = (events: NetworkEvent[] | undefined, ...subjects: string[]) =>
  (events ?? []).filter((e) => subjects.some((s) => e.subject === s || e.subject.startsWith(`${s}:`)));

/** "12:04" today, "Tue 12:04" this week, else the date. */
export const eventTime = (at: number, now = Date.now()) => {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : now - at < 6 * 86_400_000
      ? d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** Where an event's subject is shown: a device's page, a client's, the internet's; else the activity list. */
export const subjectLink = (e: Pick<NetworkEvent, "subject" | "device">) => {
  const [type, ...rest] = e.subject.split(":");
  const id = rest.join(":");
  if (type === "client") return `/clients/${encodeURIComponent(id)}`;
  if (type === "line") return "/internet";
  if (type === "app") return "/activity";
  const device = type === "device" || type === "radio" || type === "mesh" ? id : e.device;
  return device ? `/devices/${encodeURIComponent(device.split(":")[0])}` : "/activity";
};

/** The mean of a series' last few points: what loss has been lately, rather than one read's four pings. */
export const lately = (points: [number, number][], count = 5) => {
  const last = points.slice(-count);
  return last.length ? last.reduce((sum, p) => sum + p[1], 0) / last.length : undefined;
};

/** "HE80" as people say it: Wi-Fi 6, 80 MHz. */
export const modeWords = (htmode?: string) => {
  const m = /^(EHT|HE|VHT|HT)(\d+)/.exec(htmode ?? "");
  if (!m) return undefined;
  const generation = { EHT: "Wi-Fi 7", HE: "Wi-Fi 6", VHT: "Wi-Fi 5", HT: "Wi-Fi 4" }[m[1]];
  return `${generation} · ${m[2]} MHz`;
};

/** Whether it answers, in a word and a tone: rebooting, up since, or not answering. */
export const deviceState = (d: DeviceView | undefined): { word: string; tone: Tone } =>
  !d
    ? { word: "—", tone: "off" }
    : d.rebooting
      ? { word: "Restarting", tone: "fair" }
      : d.reachable
        ? { word: d.uptime ? `Up ${duration(d.uptime)}` : "Up", tone: "good" }
        : { word: "Not answering", tone: "poor" };

/** How a device reaches the router: a cable, or the mesh and how fast it measures; the router itself, the internet. */
export const uplinkWords = (intent: Intent, live: NetworkStatus | undefined, name: string) => {
  const device = intent.hardware.find((d) => d.name === name);
  if (!device) return { word: "—", tone: "off" as Tone };
  if (device.role === "router") return { word: "Router", tone: "off" as Tone };
  if (device.uplink !== "mesh") return { word: "Cable", tone: "off" as Tone };
  const best = Math.max(0, ...(live?.mesh?.find((m) => m.name === name)?.links ?? []).map((l) => l.throughput));
  return best ? { word: `Mesh ~${Math.round(best)} Mbit/s`, tone: (best < 20 ? "fair" : "good") as Tone } : { word: "Mesh: no link", tone: (live ? "poor" : "off") as Tone };
};

/** The range every chart shows: the last day, or the last 30 days (one choice for them all, kept in this browser). */
export const RangeSwitch = () => {
  const range = useRangeSwitch();
  return (
    <SegmentedControl
      size="xs"
      value={range.value}
      onChange={(v) => range.onChange(v === "month" ? "month" : "day")}
      data={[
        { value: "day", label: "Day" },
        { value: "month", label: "30 days" },
      ]}
    />
  );
};
