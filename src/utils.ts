import axios from "axios";
import { z } from "zod";

const profileSchema = z.object({
  id: z.string(),
  target: z.string(),
});

const getProfilesResponseSchema = z.object({
  profiles: z.array(profileSchema),
});

export const getProfiles = async ({ version }: { version: string }) => {
  const response = await axios({
    method: "get",
    url: `https://firmware-selector.openwrt.org/data/${version}/overview.json`,
  });
  const profiles = getProfilesResponseSchema.parse(response.data).profiles;
  return profiles;
};

export const requestBuild = async ({
  deviceModelId,
  version,
  roles,
}: {
  deviceModelId: string;
  version: string;
  roles: ("router" | "ap" | "switch")[];
}) => {
  const profiles = await getProfiles({ version });
  const deviceId = deviceModelId.replace(",", "_");

  const profile = profiles.find((profile) => profile.id === deviceId);
  if (!profile) {
    throw new Error(
      `Failed to find profile for device model id: ${deviceModelId}`
    );
  }

  const packagesMap = {
    router: [],
    ap: ["-ppp", "-firewall4"],
    switch: [],
  };

  const packages = roles.reduce<string[]>((acc, role) => {
    return [...acc, ...packagesMap[role]];
  }, []);

  const response = await axios({
    method: "post",
    url: "https://sysupgrade.openwrt.org/api/v1/build",
    data: {
      profile: deviceId,
      target: profile.target,
      version,
      packages,
    },
  });
};
