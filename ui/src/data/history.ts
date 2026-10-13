// Readings over time, for the Status pages' graphs: kept in this browser only
// (bounded, a day at most), never on the server. Each series is a list of
// [time, value], times by this browser's clock; a reading is added once per
// read. Readings are taken only while a page reads the devices, so a series
// has gaps: the charts break their line there rather than draw across.
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { NetworkStatus } from "../../../src/status/network";

export type Point = [number, number];
const maxPoints = 720;
const maxAgeMs = 24 * 3600 * 1000;
/** Two counts further apart than this say nothing about the rate now. */
const maxRateGapMs = 120_000;
/** A reading older than this is not "now". */
export const freshMs = 90_000;
const storageKey = () => `onc-history:${location.pathname}`;

const load = (): Record<string, Point[]> => {
  try {
    const kept = JSON.parse(localStorage.getItem(storageKey()) ?? "{}") as Record<string, Point[]>;
    const cutoff = Date.now() - maxAgeMs;
    return Object.fromEntries(
      Object.entries(kept)
        .map(([key, points]) => [key, Array.isArray(points) ? points.filter((p) => p[0] >= cutoff) : []] as const)
        .filter(([, points]) => points.length)
    );
  } catch {
    return {};
  }
};
const series: Record<string, Point[]> = load();
/** Each line's last byte counts, by the server's clock (rates are taken on its clock alone). */
const lastCounts: Record<string, { rx: number; tx: number; at: number }> = {};
const listeners = new Map<string, Set<() => void>>();
const changed = (key: string) => listeners.get(key)?.forEach((l) => l());
let saveSoon: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  clearTimeout(saveSoon);
  saveSoon = setTimeout(() => {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(series));
    } catch {
      // Storage blocked or full: the graphs start afresh next time.
    }
  }, 1000);
};

/** Forget every reading, here and kept: a router session ended. */
export const clearHistory = () => {
  clearTimeout(saveSoon);
  const keys = Object.keys(series);
  keys.forEach((key) => delete series[key]);
  Object.keys(lastCounts).forEach((key) => delete lastCounts[key]);
  try {
    localStorage.removeItem(storageKey());
  } catch {
    // Nothing was kept.
  }
  keys.forEach(changed);
};

/** Add a reading taken at `at`, once. A new array each time, so a series' identity says when it changed. */
export const record = (key: string, at: number, value: number) => {
  if (!Number.isFinite(value)) return;
  const list = series[key] ?? [];
  if (list.length && list[list.length - 1][0] >= at) return;
  const cutoff = Date.now() - maxAgeMs;
  series[key] = [...list, [at, value] as Point].filter((p) => p[0] >= cutoff).slice(-maxPoints);
  save();
  changed(key);
};

const forget = (key: string) => {
  if (!series[key]) return;
  delete series[key];
  save();
  changed(key);
};

/** A series, kept up to date. */
export const useSeries = (key: string): Point[] => {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => tick((n) => n + 1);
    const set = listeners.get(key) ?? new Set();
    listeners.set(key, set.add(listener));
    return () => void set.delete(listener);
  }, [key]);
  return series[key] ?? [];
};

/** The latest value, if it was read lately: an old one is not what is happening now. */
export const latest = (points: Point[], now = Date.now()) => {
  const last = points[points.length - 1];
  return last && now - last[0] < freshMs ? last[1] : undefined;
};

/**
 * Bits per second between two byte counts; undefined when they went
 * backwards (a restart) or are too far apart to say what it is now.
 */
export const rate = (before: { v: number; at: number } | undefined, now: { v: number; at: number }) =>
  before && now.at > before.at && now.at - before.at < maxRateGapMs && now.v >= before.v
    ? ((now.v - before.v) * 8) / ((now.at - before.at) / 1000)
    : undefined;

/**
 * Each line's rate from its own last count, summed: a line that has just come
 * up counts from its next read, rather than its whole count landing at once.
 */
const recordThroughput = (counters: NonNullable<NetworkStatus["internetCounters"]>, at: number) => {
  let down: number | undefined;
  let up: number | undefined;
  for (const [id, now] of Object.entries(counters.lines ?? {})) {
    const before = lastCounts[id];
    if (before && before.at >= counters.at) return;
    lastCounts[id] = { ...now, at: counters.at };
    const rx = rate(before && { v: before.rx, at: before.at }, { v: now.rx, at: counters.at });
    const tx = rate(before && { v: before.tx, at: before.at }, { v: now.tx, at: counters.at });
    if (rx !== undefined) down = (down ?? 0) + rx;
    if (tx !== undefined) up = (up ?? 0) + tx;
  }
  if (down !== undefined) record("down", at, down);
  if (up !== undefined) record("up", at, up);
};

/**
 * Every status read, whichever page made it, adds its readings, at the time
 * this browser got them. A read put back from storage may be an older
 * version's shape: one that cannot be read adds nothing, and never stops the app.
 */
export const trackHistory = (queryClient: QueryClient) =>
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== "network-status") return;
    const { data, dataUpdatedAt: at, status } = event.query.state;
    if (status !== "success" || !data) return;
    try {
      recordReadings(data as NetworkStatus, at);
    } catch {
      // Not a shape this version knows.
    }
  });

const recordReadings = (s: NetworkStatus, at: number) => {
  if (s.internetCounters) recordThroughput(s.internetCounters, at);
  if (s.internetCheck?.latencyMs !== undefined) record("latency", at, s.internetCheck.latencyMs);
  if (s.clientList) record("clients", at, s.clientList.filter((c) => c.state === "online").length);
  if (s.deviceViews) {
    for (const d of s.deviceViews) {
      if (d.load !== undefined) record(`load:${d.name}`, at, d.load / (d.cores ?? 1));
      if (d.temperature !== undefined) record(`temperature:${d.name}`, at, d.temperature);
    }
    // A device no longer in the settings keeps no history.
    const names = new Set(s.deviceViews.map((d) => d.name));
    Object.keys(series)
      .filter((key) => /^(load|temperature):/.test(key) && !names.has(key.slice(key.indexOf(":") + 1)))
      .forEach(forget);
  }
};
