// Readings over time, for the Status pages' graphs: kept in this browser only
// (bounded, a day at most), never on the server. Each series is a list of
// [time, value]; a reading is added once per read (by its time).
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { NetworkStatus } from "../../../src/status/network";

type Point = [number, number];
const maxPoints = 720;
const maxAgeMs = 24 * 3600 * 1000;
const storageKey = () => `onc-history:${location.pathname}`;

const load = (): Record<string, Point[]> => {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) ?? "{}");
  } catch {
    return {};
  }
};
const series: Record<string, Point[]> = load();
const listeners = new Set<() => void>();
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

/** Add a reading taken at `at`, once. */
export const record = (key: string, at: number, value: number) => {
  if (!Number.isFinite(value)) return;
  const list = (series[key] ??= []);
  if (list.length && list[list.length - 1][0] >= at) return;
  list.push([at, value]);
  const cutoff = Date.now() - maxAgeMs;
  while (list.length > maxPoints || (list.length && list[0][0] < cutoff)) list.shift();
  save();
  listeners.forEach((l) => l());
};

/** A series, kept up to date. */
export const useSeries = (key: string): Point[] => {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => tick((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return series[key] ?? [];
};

/**
 * Bits per second between two byte counts; undefined when they went
 * backwards (a restart) or are too far apart to say what it is now.
 */
export const rate = (before: { v: number; at: number } | undefined, now: { v: number; at: number }) =>
  before && now.at > before.at && now.at - before.at < 10 * 60_000 && now.v >= before.v
    ? ((now.v - before.v) * 8) / ((now.at - before.at) / 1000)
    : undefined;

const lastCounters: Record<string, { v: number; at: number }> = {};

/** Record the rate of a byte counter as `key`, from the last (older) count seen. */
const recordRate = (key: string, at: number, bytes: number) => {
  const before = lastCounters[key];
  if (before && before.at >= at) return;
  lastCounters[key] = { v: bytes, at };
  const r = rate(before, { v: bytes, at });
  if (r !== undefined) record(key, at, r);
};

/** Every status read, whichever page made it, adds its readings. */
export const trackHistory = (queryClient: QueryClient) =>
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== "network-status") return;
    const { data, dataUpdatedAt: at, status } = event.query.state;
    if (status !== "success" || !data) return;
    const s = data as NetworkStatus;
    if (s.internetCounters) {
      recordRate("down", s.internetCounters.at, s.internetCounters.rx);
      recordRate("up", s.internetCounters.at, s.internetCounters.tx);
    }
    if (s.internetCheck?.latencyMs !== undefined) record("latency", at, s.internetCheck.latencyMs);
    if (s.clientList) record("clients", at, s.clientList.filter((c) => c.state === "online").length);
    for (const d of s.deviceViews ?? []) {
      if (d.load !== undefined) record(`load:${d.name}`, at, d.load / (d.cores ?? 1));
      if (d.temperature !== undefined) record(`temperature:${d.name}`, at, d.temperature);
    }
  });

export const bitsWords = (bps?: number) =>
  bps === undefined ? "—" : bps >= 1e9 ? `${(bps / 1e9).toFixed(1)} Gbit/s` : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbit/s` : bps >= 1e3 ? `${Math.round(bps / 1e3)} kbit/s` : `${Math.round(bps)} bit/s`;
