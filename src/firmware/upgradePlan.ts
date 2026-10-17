// What an upgrade would do, before anything is built or flashed: which
// devices move to which release, in which order (inFlashOrder: access points
// first, those on the mesh before the cabled ones, the router last, the
// device this app runs on last of all), the images that takes, and every
// device that stays, with why. A move back is a downgrade, acknowledged
// first: within a series the settings are kept, as on an upgrade; to an
// older series they never are (older OpenWrt is not handed newer config),
// only the SSH keys, so the device comes up on the image's first-boot
// defaults, reachable under the same host key, and the apply after writes
// its whole config for that release. Those defaults have no Wi-Fi and no
// mesh, so that move is refused where it would leave a device, or this
// machine, out of reach (a mesh repeater, a node repeaters may reach the
// network through, the access point this machine is on), and where this app
// runs (it would be lost).
import type { DeviceSchema } from "../deviceSchema";
import type { Intent } from "../intent/schema";
import type { Plan } from "../plan/types";
import { imagePlans, ImagePlan, Unbuildable } from "./builds";
import { firmwareRows, FirmwareRow, inFlashOrder, movingRows, Releases } from "./target";
import { compareReleases, seriesOf, uncheckedSeries } from "../release";

export type UpgradeStep = {
  device: string;
  from: string;
  to: string;
  image: string;
  /** What the flash keeps: the settings, or (back to an older series) only the SSH keys. */
  keep: "settings" | "keys";
  /** This app runs on it: its image has the app's runtime, and it keeps the app through the flash. A local session to any other device is refused. */
  host: boolean;
};

export type UpgradePlan = {
  steps: UpgradeStep[];
  images: ImagePlan[];
  staying: { device: string; why: string }[];
  /** Devices that cannot be moved as asked, and why: nothing is flashed while any is. */
  refused: Unbuildable[];
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

/** The mesh repeaters that reach the network through `device`, if it may be a mesh node (one with a radio in the mesh's band that can mesh, or not read yet). */
const repeatersThrough = (intent: Intent, device: string, schema: DeviceSchema | undefined) => {
  const { enabled, band } = intent.wifi.mesh;
  const repeaters = intent.hardware.filter((d) => d.role === "access-point" && d.uplink === "mesh").map((d) => d.name);
  const node = !schema?.radios || schema.radios.some((r) => r.band === band && r.mesh !== false);
  return enabled && node && !repeaters.includes(device) ? repeaters : [];
};

/** Why a step back to an older series would strand something, if it would. */
const keysRefusal = (intent: Intent, step: UpgradeStep, viaWifi: string[], schema: DeviceSchema | undefined): string | undefined => {
  if (step.keep !== "keys") return undefined;
  const back = `back to an older series it comes up on first-boot settings`;
  if (step.host) return `This app runs on it: ${back}, keeping only its SSH keys, so this app and its settings would be lost. Pick a release of its own series.`;
  if (intent.hardware.find((d) => d.name === step.device)?.uplink === "mesh") {
    return `It reaches the network over the mesh: ${back}, with no mesh, and could not be reached again. Pick a release of its own series.`;
  }
  const repeaters = repeatersThrough(intent, step.device, schema);
  if (repeaters.length) {
    return `The mesh repeaters (${repeaters.join(", ")}) may reach the network through it: ${back}, with no mesh, so they could not be reached again. Pick a release of its own series.`;
  }
  if (viaWifi.includes(step.device)) {
    return `This machine reaches the network through its Wi-Fi: ${back}, with no Wi-Fi, cutting this machine off. Connect by cable, or pick a release of its own series.`;
  }
  return undefined;
};

export const upgradePlan = ({
  intent,
  plan,
  facts,
  releases,
  only,
  sha256,
  host,
  viaWifi = [],
  appKey,
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
  /** The access points this machine reaches the network through by Wi-Fi. */
  viaWifi?: string[];
  /** The public half of the key this app logs in with: no image unless it is authorized (firstBoot.ts missingKey). */
  appKey: string | undefined;
}): UpgradePlan => {
  const rows = firmwareRows({ intent, facts, releases });
  const moving = movingRows(rows, only);
  const versions = Object.fromEntries(moving.map((r) => [r.device, r.target.kind === "release" ? r.target.version : ""]));
  const { images, unbuildable } = imagePlans({ intent, plan, facts, versions, sha256, host, appKey });
  const steps = inFlashOrder(
    intent,
    moving.flatMap((r): UpgradeStep[] => {
      const image = images.find((i) => i.devices.includes(r.device));
      if (!image || !r.running) return [];
      const keep = olderSeries(r.running, image.version) ? "keys" : "settings";
      return [{ device: r.device, from: r.running, to: image.version, image: image.hash, keep, host: r.device === host }];
    }),
    (s) => s.device,
    host
  );
  const staying = rows.filter((r) => !moving.includes(r)).map((r) => ({ device: r.device, why: stayingWhy(r) }));
  const stranded = steps.flatMap((s) => {
    const why = keysRefusal(intent, s, viaWifi, facts[s.device]);
    return why ? [{ device: s.device, why }] : [];
  });
  const newSeries = [...new Set(steps.filter((s) => uncheckedSeries(s.to)).map((s) => seriesOf(s.to)!))];
  return { steps, images, staying, refused: [...unbuildable, ...stranded], newSeries, downgrades: steps.filter(isDowngrade) };
};
