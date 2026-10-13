// What an upgrade would do, before anything is built or flashed: which
// devices move to which release, in which order (access points first, those
// on the mesh before the cabled ones they reach the network through, the
// router last), the images that takes, and every device that stays, with why.
// A move back is a downgrade, acknowledged first: within a series the
// settings are kept, as on an upgrade; to an older series they never are
// (older OpenWrt is not handed newer config), only the SSH keys, so the
// device comes up on the image's first-boot defaults, reachable under the
// same host key, and the apply after writes its whole config for that release.
import type { DeviceSchema } from "../deviceSchema";
import type { Intent } from "../intent/schema";
import type { Plan } from "../plan/types";
import { imagePlans, ImagePlan, Unbuildable } from "./builds";
import { firmwareRows, FirmwareRow, Releases } from "./target";
import { compareReleases, seriesOf, uncheckedSeries } from "../release";

export type UpgradeStep = {
  device: string;
  from: string;
  to: string;
  image: string;
  /** What the flash keeps: the settings, or (back to an older series) only the SSH keys. */
  keep: "settings" | "keys";
};

export type UpgradePlan = {
  steps: UpgradeStep[];
  images: ImagePlan[];
  staying: { device: string; why: string }[];
  unbuildable: Unbuildable[];
  /** Series a step moves into that this app has not been checked against: acknowledged before any flash. */
  newSeries: string[];
  /** Steps that move a device back: acknowledged before any flash. */
  downgrades: UpgradeStep[];
};

/** Whether a move is back, and to an older series. */
export const isDowngrade = (step: Pick<UpgradeStep, "from" | "to">) => (compareReleases(step.to, step.from) ?? 0) < 0;
const olderSeries = (from: string, to: string) => (compareReleases(seriesOf(to) ?? to, seriesOf(from) ?? from) ?? 0) < 0;

const stayingWhy = (row: FirmwareRow): string => {
  switch (row.state) {
    case "current":
      return `Up to date (${row.running}).`;
    case "held":
      return "Held.";
    case "not-read":
      return "Not read yet: what it runs is not known.";
    case "unknown":
      return "Its release is not known yet: OpenWrt's releases have not been read.";
    case "update":
    case "downgrade":
      return "Not chosen.";
  }
};

/** Flashed in this order: mesh repeaters, then cabled access points, then the router (every other device reaches the app through it). */
const flashOrder = (intent: Intent, device: string) => {
  const d = intent.hardware.find((h) => h.name === device);
  return d?.role === "router" ? 2 : d?.uplink === "mesh" ? 0 : 1;
};

export const upgradePlan = ({
  intent,
  plan,
  facts,
  releases,
  only,
  sha256,
  host,
}: {
  intent: Intent;
  plan: Plan;
  facts: Record<string, DeviceSchema | undefined>;
  releases?: Releases;
  /** The devices chosen; all that can update when unset. */
  only?: string[];
  sha256: (text: string) => string;
  /** The device this app runs on: flashed last (the run ends with it), its image with the app's runtime. */
  host?: string;
}): UpgradePlan => {
  const rows = firmwareRows({ intent, facts, releases });
  const moving = rows.filter((r) => (r.state === "update" || r.state === "downgrade") && (!only || only.includes(r.device)));
  const versions = Object.fromEntries(moving.map((r) => [r.device, r.target.kind === "release" ? r.target.version : ""]));
  const { images, unbuildable } = imagePlans({ intent, plan, facts, versions, sha256, host });
  const steps = moving
    .flatMap((r) => {
      const image = images.find((i) => i.devices.includes(r.device));
      const keep = olderSeries(r.running!, image?.version ?? r.running!) ? ("keys" as const) : ("settings" as const);
      return image ? [{ device: r.device, from: r.running!, to: image.version, image: image.hash, keep }] : [];
    })
    .sort((a, b) => flashOrder(intent, a.device) - flashOrder(intent, b.device))
    .sort((a, b) => Number(a.device === host) - Number(b.device === host));
  const staying = rows.filter((r) => !moving.includes(r)).map((r) => ({ device: r.device, why: stayingWhy(r) }));
  const newSeries = [...new Set(steps.filter((s) => uncheckedSeries(s.to)).map((s) => seriesOf(s.to)!))];
  return { steps, images, staying, unbuildable, newSeries, downgrades: steps.filter(isDowngrade) };
};
