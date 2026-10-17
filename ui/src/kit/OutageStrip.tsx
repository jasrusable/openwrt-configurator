// Was it up: a cell per hour for the last day, or per day for 30 days,
// green where every read found it up, amber where some did not, red where
// most did not, grey where nothing was read (the collector was not running:
// never counted as up). The share up leaves unread time out.
import { Box, Group, Text } from "@mantine/core";
import { cellTone, uptimeOf } from "../../../src/status/health";
import { ranges } from "../../../src/status/history";
import type { Range } from "../data/history";
import { Hint } from "./Hint";
import { toneColor } from "./status";

type Point = [number, number, number];

/** Each cell's start: the last 24 whole hours, or the last 30 days from local midnight, the current one last. */
const cellsOf = (range: Range, now: number) => {
  if (range === "day") {
    const hour = 3600_000;
    const current = now - (now % hour);
    return Array.from({ length: 24 }, (_, i) => ({ start: current - (23 - i) * hour, end: current - (22 - i) * hour }));
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Array.from({ length: 30 }, (_, i) => {
    const start = new Date(midnight);
    start.setDate(start.getDate() - (29 - i));
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start: start.getTime(), end: end.getTime() };
  });
};

const minutes = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3600_000)} h`);

export const OutageStrip = ({ points, range, now = Date.now(), label }: { points: Point[]; range: Range; now?: number; label: string }) => {
  const { bucketMs } = ranges[range];
  const cells = cellsOf(range, now).map((cell) => {
    const inside = points.filter(([t]) => t >= cell.start && t < cell.end);
    const share = uptimeOf(inside);
    // Each point is a bucket that was read: down for the share of it its reads found down.
    const down = inside.reduce((sum, p) => sum + (1 - p[1]) * bucketMs, 0);
    return { ...cell, share, down, read: inside.length > 0 };
  });
  const share = uptimeOf(points.filter(([t]) => t >= cells[0].start));
  const when = (t: number) =>
    range === "day"
      ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return (
    <Group gap="md" wrap="nowrap" align="center">
      {/* A grid: each cell's Hint wraps it in a span, which is what a row would size. */}
      <Box style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`, gap: 2 }} role="img" aria-label={`${label}: ${share === undefined ? "nothing read" : `${(share * 100).toFixed(2)}% up`}`}>
        {cells.map((cell) => (
          <Hint
            key={cell.start}
            width={220}
            label={`${when(cell.start)}${range === "day" ? `–${when(cell.end)}` : ""} · ${
              !cell.read ? "not read" : cell.down < 1000 ? "up" : `down about ${minutes(cell.down)}`
            }`}
          >
            <Box
              h={22}
              style={{
                flex: 1,
                minWidth: 0,
                borderRadius: 3,
                background: cell.read ? `var(--mantine-color-${toneColor[cellTone(cell.share)]}-6)` : "var(--onc-separator)",
                opacity: cell.read ? 0.9 : 1,
              }}
            />
          </Hint>
        ))}
      </Box>
      <Text size="sm" fw={600} style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", flexShrink: 0 }}>
        {share === undefined ? "—" : `${share === 1 ? "100" : (Math.floor(share * 10000) / 100).toFixed(2)}% up`}
      </Text>
    </Group>
  );
};
