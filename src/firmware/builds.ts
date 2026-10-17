// The images an upgrade needs: one per board, role and release, shared by
// every device that would get the same one (five identical access points,
// one build), built on ASU in parallel and kept beside the intent by what
// went into them, so a retry or a later upgrade downloads nothing again.
// What goes in is the role's packages (resolved against the device's facts
// at the new release, as an apply would install them: full wpad for a mesh)
// and the role's first-boot script: nothing per device, nothing secret. An
// image that cannot be built is said, per build, before anything is
// flashed; there is never a stock image instead (it would lack the role's
// packages: a mesh repeater on one could not rejoin).
import { z } from "zod";
import { downloadImage, pickSysupgradeImage, pollBuild, requestBuild } from "../buildImage";
import type { DeviceSchema } from "../deviceSchema";
import { resolveDeclarations } from "../engine/resolvePlan";
import type { Intent } from "../intent/schema";
import { Platform } from "../platform";
import type { Plan } from "../plan/types";
import { attempt, messageOf } from "../result";
import { read, stateLayout, StoreKey, write } from "../store";
import { firstBootMaxBytes, firstBootOf, firstBootScript, missingKey, Role } from "./firstBoot";
import { findProfile } from "./profiles";

export type ImagePlan = {
  /** What identifies the image: the same for every device that would get the same one. */
  hash: string;
  version: string;
  /** The board, as OpenWrt names it (board.json): which ASU profile builds for it. */
  board: string;
  /** OpenWrt's target/subtarget, from the facts. */
  target: string;
  role: Role;
  /** As ASU takes them: a leading "-" leaves one of the release's defaults out. */
  packages: string[];
  /** The first-boot script (firstBoot.ts). */
  defaults: string;
  devices: string[];
};

/** What this app runs with on a router (its own package is not in OpenWrt's feeds, so not in an image). */
export const appRuntime = ["quickjs", "uhttpd"];

/** A device the plan could not make an image for, and why. */
export type Unbuildable = { device: string; why: string };

/** The packages an apply would leave on a device at `version`, as ASU takes them; undefined when the settings compile no such device. */
const packagesAt = (plan: Plan, hostname: string, schema: DeviceSchema): string[] | undefined => {
  const device = plan.devices.find((d) => d.hostname === hostname);
  if (!device) return undefined;
  const { packages } = resolveDeclarations(plan, device, schema);
  const added = packages.flatMap((p) => p.add ?? []);
  const removed = packages.flatMap((p) => p.remove ?? []).filter((name) => !added.includes(name));
  return [...new Set([...added, ...removed.map((name) => `-${name}`)])].sort();
};

/**
 * The images for moving each device in `versions` to its release, grouped:
 * devices that would get the same image share one.
 */
export const imagePlans = ({
  intent,
  plan,
  facts,
  versions,
  sha256,
  host,
  appKey,
}: {
  intent: Intent;
  plan: Plan;
  facts: Record<string, DeviceSchema | undefined>;
  versions: Record<string, string>;
  sha256: (text: string) => string;
  /** The device this app runs on: its image also has what the app runs with (it is reinstalled from a kept copy). */
  host?: string;
  /** The public half of the key this app logs in with (src/loginAccess.ts appPublicKey): no image unless it is authorized. */
  appKey: string | undefined;
}): { images: ImagePlan[]; unbuildable: Unbuildable[] } => {
  // The one place the key is checked: every image comes through here (an upgrade, build-images).
  const noKey = missingKey(intent, appKey);
  if (noKey) return { images: [], unbuildable: Object.keys(versions).map((device) => ({ device, why: noKey })) };
  const each = Object.entries(versions).map(([device, version]) => {
    const schema = facts[device];
    const role = intent.hardware.find((d) => d.name === device)?.role;
    if (!role) return { device, why: "It is not in Hardware." };
    if (!schema) return { device, why: "Its facts have not been read: its board is not known." };
    if (!schema.target) return { device, why: "Its facts do not say its target: read it again." };
    const defaults = firstBootScript(firstBootOf(intent, role));
    if (defaults.length > firstBootMaxBytes) return { device, why: "Its first-boot script is over ASU's 20 KB." };
    const roles = packagesAt(plan, device, { ...schema, version });
    // Never an image without the role's packages: on one, a mesh repeater could not rejoin.
    if (!roles) return { device, why: "The settings compile no such device: its packages are not known." };
    const packages = [...new Set([...roles, ...(device === host ? appRuntime : [])])].sort();
    const what = { version, board: schema.name, target: schema.target, role, packages, defaults };
    return { device, image: { ...what, hash: sha256(JSON.stringify(what)).slice(0, 16) } };
  });
  const images = each.reduce<ImagePlan[]>((all, entry) => {
    if (!("image" in entry) || !entry.image) return all;
    const same = all.find((i) => i.hash === entry.image.hash);
    return same
      ? all.map((i) => (i === same ? { ...i, devices: [...i.devices, entry.device] } : i))
      : [...all, { ...entry.image, devices: [entry.device] }];
  }, []);
  const unbuildable = each.flatMap((entry) => ("why" in entry && entry.why ? [{ device: entry.device, why: entry.why }] : []));
  return { images, unbuildable };
};

/** An image kept beside the intent: its file, and what ASU said its sha256 was. */
export type BuiltImage = { hash: string; path: string; sha256: string; size: number; name: string };

const imagesDir = (intentPath: string) => stateLayout(intentPath).images;

const builtKey = (intentPath: string, hash: string): StoreKey<BuiltImage> => ({
  path: `${imagesDir(intentPath)}/${hash}.json`,
  schema: z.object({ hash: z.string(), path: z.string(), sha256: z.string(), size: z.number(), name: z.string() }),
  format: 1,
});

type BuildPlatform = Pick<
  Platform,
  "http" | "sleep" | "mkdirp" | "sha256File" | "readFileHead" | "removeFile" | "readTextFile" | "writeFileAtomic"
>;

/** The image kept for a plan, if its file is still whole. */
const keptImage = async (intentPath: string, image: ImagePlan, platform: BuildPlatform) => {
  const kept = read(platform, builtKey(intentPath, image.hash));
  if (!kept) return undefined;
  const whole = await attempt(() => platform.sha256File(kept.path), () => undefined);
  return whole.ok && whole.value === kept.sha256 ? kept : undefined;
};

/** One image built on ASU, nothing downloaded: the build, and the sysupgrade image in it. */
export const buildOnAsu = async ({
  image,
  platform,
  log = () => {},
}: {
  image: ImagePlan;
  platform: Pick<Platform, "http" | "sleep">;
  log?: (line: string) => void;
}) => {
  const profile = await findProfile({ version: image.version, target: image.target, board: image.board, platform });
  log(`${image.board} ${image.version}: building on ASU (${image.target}/${profile})`);
  const { requestHash } = await requestBuild({
    req: { version: image.version, target: image.target, profile, packages: image.packages, defaults: image.defaults },
    platform,
  });
  const build = await pollBuild({ requestHash, platform });
  return { build, sysupgrade: pickSysupgradeImage(build) };
};

/** One image: kept, or built on ASU, downloaded and checked. */
export const buildOne = async ({
  intentPath,
  image,
  platform,
  log = () => {},
}: {
  intentPath: string;
  image: ImagePlan;
  platform: BuildPlatform;
  log?: (line: string) => void;
}): Promise<BuiltImage> => {
  const kept = await keptImage(intentPath, image, platform);
  if (kept) return kept;
  const { build, sysupgrade } = await buildOnAsu({ image, platform, log });
  const path = `${imagesDir(intentPath)}/${image.hash}.bin`;
  log(`${image.board} ${image.version}: downloading ${sysupgrade.name}`);
  platform.mkdirp(imagesDir(intentPath), 0o700);
  const verified = await downloadImage({
    binDir: build.bin_dir,
    name: sysupgrade.name,
    outPath: path,
    expectedSha256: sysupgrade.sha256,
    expectedSize: sysupgrade.size,
    platform,
  });
  const built: BuiltImage = { hash: image.hash, path, sha256: verified.sha256, size: verified.size, name: sysupgrade.name };
  write(platform, builtKey(intentPath, image.hash), built);
  return built;
};

export type BuildOutcome = { image: ImagePlan } & ({ built: BuiltImage } | { error: string });

/** Every image, `concurrency` at a time; each one's failure its own, said. */
export const buildAll = async ({
  intentPath,
  images,
  platform,
  concurrency = 3,
  log,
}: {
  intentPath: string;
  images: ImagePlan[];
  platform: BuildPlatform;
  concurrency?: number;
  log?: (line: string) => void;
}): Promise<BuildOutcome[]> => {
  const outcomes: BuildOutcome[] = [];
  const queue = [...images];
  const worker = async () => {
    for (let image = queue.shift(); image; image = queue.shift()) {
      const done = await attempt(() => buildOne({ intentPath, image: image!, platform, log }), messageOf);
      outcomes.push(done.ok ? { image, built: done.value } : { image, error: done.error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), images.length) }, worker));
  // In the plan's order, whichever finished first.
  return images.map((image) => outcomes.find((o) => o.image === image)!);
};
