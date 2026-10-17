// A reading over time, as the Status pages draw it: the whole range across
// (a day, or 30 days), so time nothing read is a gap and never a line drawn
// over it; three clean ticks up the side; where a reading turns fair and
// poor, faintly behind; what happened, marked where it happened (an outage,
// an apply, a restart); and a crosshair that reads every series at once,
// with the keyboard too. 2px lines, a 10% wash under them, text in text
// colours (docs/status-redesign.md; the dataviz rules).
import { Box, Group, Stack, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { KeyboardEvent, PointerEvent, useId, useState } from "react";
import type { Tone } from "../../../src/status/health";
import { ranges, RangeRule } from "../../../src/status/history";
import type { Range } from "../data/history";
import { seriesColor, toneColor } from "./status";

type Point = [number, number];

export type ChartSeries = { label: string; points: Point[] };
export type ChartEvent = { at: number; text: string; tone: Tone };
/** A stretch of values that reads as a tone: from, to (open: the top). */
export type ChartBand = { from: number; to?: number; tone: Tone };

const margins = { right: 10, top: 10, bottom: 20 };

/** A round span for the scale, at least `v`: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten (60 stays 60). */
export const niceSpan = (v: number) => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v - 1e-9) ?? 10) * p;
};

/** A series as its unbroken runs: points further apart than three of the range's steps were not read between. */
const runsOf = (points: Point[], stepMs: number) =>
  points.reduce<Point[][]>((out, p, i) => {
    if (i === 0 || p[0] - points[i - 1][0] > 3 * stepMs) out.push([]);
    out[out.length - 1].push(p);
    return out;
  }, []);

/** A tick's time: the hour for a day ("14:00", "2 PM"), the date for 30 days. */
const timeLabel = (t: number, range: Range) =>
  range === "day"
    ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric" })
    : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const whenLabel = (t: number, range: Range) =>
  range === "day"
    ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const TimeChart = ({
  series,
  range,
  format,
  height = 140,
  min = 0,
  max,
  bands = [],
  events = [],
  label,
  step,
  now = Date.now(),
}: {
  series: ChartSeries[];
  range: Range;
  /** A value in words, with its unit: "12 ms". */
  format: (value: number) => string;
  height?: number;
  min?: number;
  /** The scale's top at least (it grows with the readings). */
  max?: number;
  bands?: ChartBand[];
  events?: ChartEvent[];
  /** What it shows, for a screen reader. */
  label: string;
  /** Points kept at another step and span than the range's (a client's: 10 minutes for a day). */
  step?: RangeRule;
  now?: number;
}) => {
  const id = useId();
  const { ref, width } = useElementSize();
  const [at, setAt] = useState<number | undefined>();
  const { bucketMs, keepMs } = step ?? ranges[range];
  const [t0, t1] = [now - keepMs, now];
  const shown = series.map((s) => ({ ...s, points: s.points.filter(([t]) => t >= t0) }));
  const values = shown.flatMap((s) => s.points.map((p) => p[1]));
  // The scale from its floor up to a round span over the readings (and `max`), so a scale below zero (dBm) reads right.
  const top = min + niceSpan(Math.max(max ?? min, ...values) - min);
  const ticks = [min, (min + top) / 2, top];
  // Room on the left for the longest tick label, at about 6 px a character.
  const left = Math.max(32, Math.max(...ticks.map((v) => format(v).length)) * 6 + 10);
  const pad = { ...margins, left };
  const inner = { w: Math.max(width - pad.left - pad.right, 1), h: height - pad.top - pad.bottom };
  const x = (t: number) => pad.left + ((t - t0) / (t1 - t0)) * inner.w;
  const y = (v: number) => pad.top + inner.h - ((Math.min(Math.max(v, min), top) - min) / (top - min)) * inner.h;
  const times = [...new Set(shown.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const nearest = (t: number) => times.reduce<number | undefined>((best, c) => (best === undefined || Math.abs(c - t) < Math.abs(best - t) ? c : best), undefined);
  const valueAt = (points: Point[], t: number) => points.find((p) => Math.abs(p[0] - t) < bucketMs / 2)?.[1];
  const eventsAt = (t: number) => events.filter((e) => Math.abs(e.at - t) <= bucketMs * 1.5);
  const visibleEvents = events.filter((e) => e.at >= t0 && e.at <= t1);
  const onPointer = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - box.left) / box.width) * (t1 - t0);
    setAt(nearest(t));
  };
  const onKey = (e: KeyboardEvent<SVGRectElement>) => {
    if (!times.length) return;
    const i = at === undefined ? times.length - 1 : times.indexOf(at);
    if (e.key === "ArrowLeft") setAt(times[Math.max(0, i - 1)]);
    else if (e.key === "ArrowRight") setAt(times[Math.min(times.length - 1, i + 1)]);
    else if (e.key === "Escape") setAt(undefined);
    else return;
    e.preventDefault();
  };
  const latest = shown.map((s) => s.points[s.points.length - 1]?.[1]);
  const summary = `${label}, ${range === "day" ? "the last day" : "the last 30 days"}: ${
    times.length ? shown.map((s, i) => `${s.label} now ${latest[i] !== undefined ? format(latest[i]!) : "not read"}`).join(", ") : "nothing read yet"
  }.`;
  // Five times across a wide chart, three across a narrow one, so none run into each other.
  const xTicks = (inner.w < 420 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) => t0 + f * (t1 - t0));
  const tipLeft = at !== undefined && x(at) > width / 2;
  return (
    <Stack gap={6}>
      {shown.length > 1 && (
        <Group gap="md">
          {shown.map((s, i) => (
            <Group key={s.label} gap={6} wrap="nowrap">
              <Box w={14} h={2} style={{ background: seriesColor[i % seriesColor.length], borderRadius: 1 }} />
              <Text size="xs" c="dimmed">
                {s.label}
              </Text>
            </Group>
          ))}
        </Group>
      )}
      <Box ref={ref} pos="relative" h={height}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={summary}>
            {bands.map((b, i) => {
              const [from, to] = [Math.max(b.from, min), Math.min(b.to ?? top, top)];
              return from < to ? (
                <rect key={i} x={pad.left} width={inner.w} y={y(to)} height={y(from) - y(to)} fill={`var(--mantine-color-${toneColor[b.tone]}-6)`} opacity={0.06} />
              ) : null;
            })}
            {ticks.map((v, i) => (
              <g key={i}>
                <line x1={pad.left} x2={pad.left + inner.w} y1={y(v)} y2={y(v)} stroke="var(--onc-separator)" strokeWidth={1} />
                <text x={pad.left - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--onc-label-2)" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {format(v)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={i} x={x(t)} y={height - 4} fontSize={10} fill="var(--onc-label-2)" textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
                {i === xTicks.length - 1 ? "now" : timeLabel(t, range)}
              </text>
            ))}
            {shown.map((s, i) => {
              const color = seriesColor[i % seriesColor.length];
              return (
                <g key={s.label}>
                  <defs>
                    <linearGradient id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.14} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  {runsOf(s.points, bucketMs).map((run, j) => {
                    const line = run.map(([t, v]) => `${x(t)},${y(v)}`).join(" ");
                    return run.length === 1 ? (
                      <circle key={j} cx={x(run[0][0])} cy={y(run[0][1])} r={2} fill={color} />
                    ) : (
                      <g key={j}>
                        <polygon points={`${x(run[0][0])},${y(min)} ${line} ${x(run[run.length - 1][0])},${y(min)}`} fill={`url(#${id}-${i})`} />
                        <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {visibleEvents.map((e, i) => (
              <g key={i}>
                <line x1={x(e.at)} x2={x(e.at)} y1={pad.top} y2={pad.top + inner.h} stroke={`var(--mantine-color-${toneColor[e.tone]}-6)`} strokeWidth={1} opacity={0.5} />
                <circle cx={x(e.at)} cy={pad.top} r={4} fill={`var(--mantine-color-${toneColor[e.tone]}-6)`} stroke="var(--onc-card)" strokeWidth={2} />
              </g>
            ))}
            {at !== undefined && (
              <g>
                <line x1={x(at)} x2={x(at)} y1={pad.top} y2={pad.top + inner.h} stroke="var(--mantine-color-text)" strokeWidth={1} opacity={0.35} />
                {shown.map((s, i) => {
                  const v = valueAt(s.points, at);
                  return v === undefined ? null : <circle key={s.label} cx={x(at)} cy={y(v)} r={4} fill={seriesColor[i % seriesColor.length]} stroke="var(--onc-card)" strokeWidth={2} />;
                })}
              </g>
            )}
            <rect
              x={pad.left}
              y={0}
              width={inner.w}
              height={height}
              fill="transparent"
              tabIndex={0}
              aria-label={`${label}: use the arrow keys to read each point`}
              onPointerMove={onPointer}
              onPointerLeave={() => setAt(undefined)}
              onFocus={() => setAt((current) => current ?? times[times.length - 1])}
              onBlur={() => setAt(undefined)}
              onKeyDown={onKey}
              style={{ outline: "none" }}
            />
          </svg>
        )}
        {width > 0 && !times.length && (
          <Text size="xs" c="dimmed" pos="absolute" top="40%" left={0} right={0} ta="center">
            Nothing read in this range yet.
          </Text>
        )}
        {at !== undefined && (
          <Box className="onc-chart-tip" style={tipLeft ? { right: width - x(at) + 10 } : { left: x(at) + 10 }}>
            <Text size="xs" c="dimmed">
              {whenLabel(at, range)}
            </Text>
            {shown.map((s, i) => {
              const v = valueAt(s.points, at);
              return (
                <Group key={s.label} gap={6} wrap="nowrap">
                  <Box w={10} h={2} style={{ background: seriesColor[i % seriesColor.length], borderRadius: 1, flexShrink: 0 }} />
                  <Text size="sm" fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
                    {v === undefined ? "—" : format(v)}
                  </Text>
                  {shown.length > 1 && (
                    <Text size="xs" c="dimmed">
                      {s.label}
                    </Text>
                  )}
                </Group>
              );
            })}
            {eventsAt(at).map((e, i) => (
              <Group key={i} gap={6} wrap="nowrap" mt={2}>
                <Box w={8} h={8} style={{ borderRadius: 4, background: `var(--mantine-color-${toneColor[e.tone]}-6)`, flexShrink: 0 }} />
                <Text size="xs">{e.text}</Text>
              </Group>
            ))}
          </Box>
        )}
      </Box>
    </Stack>
  );
};
