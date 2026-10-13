// Which image profile builds for a board: the release's target lists each
// profile with the board names it supports (profiles.json, as owut reads
// it), so a board whose profile is named otherwise (linksys,e8450 →
// linksys_e8450-ubi) is still found. Read once per release and target.
import { z } from "zod";
import { Platform } from "../platform";

const profilesSchema = z.object({
  profiles: z.record(z.string(), z.object({ supported_devices: z.array(z.string()).default([]) })),
});

const read = new Map<string, Promise<Record<string, string[]>>>();

export const profilesUrl = (version: string, target: string) =>
  `https://downloads.openwrt.org/releases/${version}/targets/${target}/profiles.json`;

/** Each profile of a release's target, and the boards it supports. */
const profilesOf = (version: string, target: string, platform: Pick<Platform, "http">) => {
  const key = `${version} ${target}`;
  const known =
    read.get(key) ??
    (async () => {
      const response = await platform.http.request({ method: "GET", url: profilesUrl(version, target) });
      if (response.status !== 200) throw new Error(`OpenWrt ${version} has no ${target} target (${response.status}).`);
      const parsed = (() => {
        try {
          return profilesSchema.safeParse(JSON.parse(response.body));
        } catch {
          return undefined;
        }
      })();
      if (!parsed?.success) throw new Error(`OpenWrt ${version}'s ${target} profiles could not be read.`);
      return Object.fromEntries(Object.entries(parsed.data.profiles).map(([id, p]) => [id, p.supported_devices]));
    })();
  read.set(key, known);
  // A failed read is asked again next time.
  known.catch(() => read.delete(key));
  return known;
};

/** The profile whose supported boards name this one (else the board's own name, as OpenWrt spells profiles). */
export const profileFor = (profiles: Record<string, string[]>, board: string) =>
  Object.entries(profiles).find(([, boards]) => boards.includes(board))?.[0] ??
  (board.replace(",", "_") in profiles ? board.replace(",", "_") : undefined);

export const findProfile = async ({
  version,
  target,
  board,
  platform,
}: {
  version: string;
  target: string;
  board: string;
  platform: Pick<Platform, "http">;
}) => {
  const profile = profileFor(await profilesOf(version, target, platform), board);
  if (!profile) throw new Error(`OpenWrt ${version} builds no image for ${board} (${target}).`);
  return profile;
};
