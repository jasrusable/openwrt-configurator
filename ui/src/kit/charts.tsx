// Small, quiet visuals for the Status pages, in plain SVG and Mantine's own
// rings: an area chart, signal bars, a stat tile, a port faceplate. Colours
// come from Mantine's palette variables, so dark mode holds.
import { Box, Group, RingProgress, SegmentedControl, Stack, Text } from "@mantine/core";
import { Hint } from "./Hint";
import { ReactNode, useId } from "react";
import { linkWords } from "./format";

type Point = [number, number];

/**
 * Points further apart than three of the series' own steps (a minute's, or
 * 15 minutes' for 30 days) were not read in between: the line breaks there.
 */
const gapOf = (points: Point[]) => {
  const steps = points.slice(1).map((p, i) => p[0] - points[i][0]).filter((d) => d > 0);
  return 3 * (steps.length ? Math.min(...steps) : 60_000);
};

/** A series as its unbroken runs. */
const runs = (points: Point[]) => {
  const gap = gapOf(points);
  return points.reduce<Point[][]>((out, p, i) => {
    if (i > 0 && p[0] - points[i - 1][0] > gap) out.push([]);
    out[out.length - 1].push(p);
    return out;
  }, [[]]);
};

/** One or two series over time, filled below; now at the right; broken where no readings were taken. */
export const AreaChart = ({
  series,
  colors = ["blue", "teal"],
  height = 64,
  min = 0,
  max: ceiling,
}: {
  series: Point[][];
  colors?: string[];
  height?: number;
  /** The scale's floor, and its top: the top grows with the readings when they pass it, or is theirs when unset. */
  min?: number;
  max?: number;
}) => {
  const id = useId();
  const all = series.flat();
  if (series.every((points) => runs(points).every((run) => run.length < 2))) {
    // A small chart in a tile just waits; a full one says why it is empty.
    return height < 60 ? (
      <Box h={height} />
    ) : (
      <Box h={height} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Text size="xs" c="dimmed">
          The graph fills in as readings come.
        </Text>
      </Box>
    );
  }
  // At the right, the bucket now filling, not the newest point: a series no
  // longer read ends where it stopped rather than being drawn as current.
  const step = Math.min(...series.map((points) => gapOf(points) / 3));
  const [t0, t1] = [Math.min(...all.map((p) => p[0])), Math.max(Date.now() - step, ...all.map((p) => p[0]))];
  const max = Math.max(...all.map((p) => p[1]), ceiling ?? 1e-9, min + 1e-9);
  const x = (t: number) => ((t - t0) / Math.max(t1 - t0, 1)) * 100;
  const y = (v: number) => 38 - ((Math.max(v, min) - min) / (max - min)) * 36;
  return (
    <svg width="100%" height={height} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
      {series.map((points, i) => {
        const color = `var(--mantine-color-${colors[i % colors.length]}-5)`;
        return (
          <g key={i}>
            <defs>
              <linearGradient id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {runs(points)
              .filter((run) => run.length >= 2)
              .map((run, j) => {
                const line = run.map(([t, v]) => `${x(t)},${y(v)}`).join(" ");
                return (
                  <g key={j}>
                    <polygon points={`${x(run[0][0])},40 ${line} ${x(run[run.length - 1][0])},40`} fill={`url(#${id}-${i})`} />
                    <polyline points={line} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
          </g>
        );
      })}
    </svg>
  );
};

/** Four bars for a Wi-Fi signal, filled by strength, with the dBm on hover. */
export const SignalBars = ({ dbm }: { dbm?: number }) => {
  if (dbm === undefined) return null;
  const level = dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
  const color = level >= 3 ? "green" : level === 2 ? "yellow" : "red";
  return (
    <Hint label={`${dbm} dBm`}>
      <svg width={18} height={14} viewBox="0 0 18 14" aria-label={`signal ${dbm} dBm`}>
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={i * 4.5}
            y={10 - i * 3}
            width={3}
            height={4 + i * 3}
            rx={0.8}
            fill={i < level ? `var(--mantine-color-${color}-6)` : "var(--onc-separator)"}
          />
        ))}
      </svg>
    </Hint>
  );
};

/** A card holding a chart: its title, what each colour is, the time it spans, and (a graph over time) its range. */
export const ChartCard = ({
  title,
  legend = [],
  span,
  range,
  children,
}: {
  title: ReactNode;
  legend?: { label: ReactNode; color: string }[];
  /** When the oldest reading shown was taken. */
  span?: number;
  /** A graph over time: the range it shows, and how to change it (every graph's). */
  range?: { value: "day" | "month"; onChange: (range: "day" | "month") => void };
  children: ReactNode;
}) => (
  <Box className="onc-card" p="md">
    <Group justify="space-between" mb={8} wrap="nowrap">
      <Text component="div" size="sm" fw={600} style={{ minWidth: 0 }}>
        {title}
      </Text>
      <Group gap="md" wrap="nowrap">
        {legend.map((l, i) => (
          <Group key={i} gap={6} wrap="nowrap">
            <Box w={8} h={8} style={{ borderRadius: 4, background: `var(--mantine-color-${l.color}-5)` }} />
            <Text size="xs" c="dimmed">
              {l.label}
            </Text>
          </Group>
        ))}
        {span !== undefined && (
          <Text size="xs" c="dimmed">
            {spanWords(Date.now() - span)}
          </Text>
        )}
        {range && (
          <SegmentedControl
            size="xs"
            value={range.value}
            onChange={(v) => range.onChange(v === "month" ? "month" : "day")}
            data={[
              { value: "day", label: "Day" },
              { value: "month", label: "30 days" },
            ]}
          />
        )}
      </Group>
    </Group>
    {children}
  </Box>
);

const spanWords = (ms: number) =>
  ms < 90_000
    ? "last minute"
    : ms < 90 * 60_000
      ? `last ${Math.round(ms / 60_000)} min`
      : ms < 48 * 3_600_000
        ? `last ${Math.round(ms / 3_600_000)} h`
        : `last ${Math.round(ms / 86_400_000)} days`;

/** A headline number: what, how much, a line under it, and a trend or anything else. */
export const Tile = ({
  label,
  value,
  sub,
  color,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  children?: ReactNode;
}) => (
  <Box className="onc-card" p="md">
    <Stack gap={4}>
      <Text size="xs" c="dimmed" fw={500}>
        {label}
      </Text>
      <Text component="div" fz={26} fw={600} lh={1.15} c={color ? `${color}.6` : undefined}>
        {value}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
      {children}
    </Stack>
  </Box>
);

/** A share as a ring, with its words in the middle. */
export const Ring = ({ share, label, color }: { share: number; label: string; color?: string }) => {
  const c = color ?? (share >= 0.9 ? "red" : share >= 0.7 ? "orange" : "teal");
  return (
    <Stack gap={2} align="center">
      <RingProgress
        size={78}
        thickness={7}
        roundCaps
        sections={[{ value: Math.min(100, Math.max(0, share * 100)), color: c }]}
        label={
          <Text ta="center" size="sm" fw={600}>
            {Math.round(share * 100)}%
          </Text>
        }
      />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
};

/** A device's ports as a faceplate: lit when connected, with the speed under each. */
export const PortFace = ({ ports }: { ports: { name: string; up: boolean; speed?: number }[] }) => (
  <Group gap={8}>
    {ports.map((p) => (
      <Stack key={p.name} gap={3} align="center">
        <Hint label={p.up ? `${p.name}: connected${p.speed ? ` at ${linkWords(p.speed)}` : ""}` : `${p.name}: nothing connected`}>
          <Box
            w={34}
            h={26}
            style={{
              borderRadius: 5,
              border: "1.5px solid var(--onc-separator)",
              background: p.up ? `var(--mantine-color-${p.speed && p.speed >= 2500 ? "teal" : p.speed && p.speed >= 1000 ? "green" : "yellow"}-6)` : "var(--onc-page)",
              boxShadow: "inset 0 -5px 0 var(--onc-separator)",
            }}
          />
        </Hint>
        <Text size="10px" c="dimmed">
          {p.name}
        </Text>
        <Text size="10px" c={p.up ? undefined : "dimmed"} fw={500}>
          {p.up ? (p.speed ? linkWords(p.speed) : "up") : "—"}
        </Text>
      </Stack>
    ))}
  </Group>
);

