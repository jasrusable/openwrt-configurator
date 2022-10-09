import axios from "axios";
import { NodeSSH } from "node-ssh";
import { z, ZodError, ZodObject, ZodRawShape, ZodSchema } from "zod";
import { DeviceSchema } from "./deviceSchema";
import { ONCConfig } from "./oncConfigSchema";
import { allHtModes, wifiBands, wifiTypes } from "./openWrtValues";

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

export const boardJsonSchema = z.object({
  model: z.object({
    id: z.string(),
  }),
  switch: z
    .record(
      z.object({
        enable: z.boolean(),
        reset: z.boolean(),
        ports: z.array(
          z.object({
            num: z.number(),
            role: z.enum(["lan", "wan"]).optional(),
            device: z.string().optional(),
          })
        ),
      })
    )
    .optional(),
  network: z.object({
    lan: z.object({
      ports: z.array(z.string()).optional(),
      device: z.string().optional(),
      protocol: z.string(),
    }),
    wan: z.object({
      device: z.string().optional(),
      protocol: z.string(),
      ports: z.array(z.string()).optional(),
    }),
  }),
});

export const getBoardJson = async (ssh: NodeSSH) => {
  const boardJsonResult = await ssh.execCommand("cat /etc/board.json");
  if (!boardJsonResult.stdout || boardJsonResult.code !== 0) {
    throw new Error("Failed to verify /etc/board.json file.");
  }
  const boardJson = parseSchema(
    boardJsonSchema,
    JSON.parse(boardJsonResult.stdout)
  );
  return boardJson;
};

const wirelessConfigSchema = z.object({
  values: z.record(
    z.object({
      ".type": z.enum(["wifi-device"]),
      ".name": z.string(),
      type: z.enum(wifiTypes),
      path: z.string(),
      channel: z.string(),
      band: z.enum(wifiBands),
      htmode: z.enum(allHtModes).optional(),
    })
  ),
});

export const getRadios = async (ssh: NodeSSH) => {
  const wirelessStatus = await ssh.execCommand(
    `ubus call uci get '{"config": "wireless", "type": "wifi-device"}'`
  );
  if (!wirelessStatus.stdout || wirelessStatus.code !== 0) {
    if (wirelessStatus.stderr === "Command failed: Not found") {
      return [];
    } else {
      console.error(wirelessStatus.stderr);
      throw new Error("Failed to get wireless status");
    }
  }
  const parsedWirelessStatus = parseSchema(
    wirelessConfigSchema,
    JSON.parse(wirelessStatus.stdout)
  );
  const radios = Object.values(parsedWirelessStatus.values);
  return radios;
};

export const getInstalledPackages = async (ssh: NodeSSH) => {
  const command = await ssh.execCommand(`opkg list-installed`);
  if (!command.stdout || command.code !== 0) {
    if (command.stderr === "Command failed: Not found") {
      return [];
    } else {
      console.error(command.stderr);
      throw new Error("Failed to get wireless status");
    }
  }

  const packageLines = command.stdout.split("\n");

  const packages = packageLines.map((line) => {
    const [packageName, version] = line.split(" - ");
    return {
      packageName,
      version,
    };
  });

  return packages;
};

export const getDeviceVersion = async (ssh: NodeSSH) => {
  const versionResult = await ssh.execCommand("cat /etc/openwrt_release");
  const lines = versionResult.stdout.split("\n");
  const distribReleaseLine = lines.find((line) =>
    line.startsWith("DISTRIB_RELEASE")
  );
  if (!distribReleaseLine) {
    throw new Error(
      "Failed to determine device version in /etc/openwrt_release"
    );
  }
  const version = distribReleaseLine
    .split("=")[1]
    .replace(`'`, "")
    .replace(`'`, "");
  return version;
};

export const parseSchema = <D>(schema: ZodSchema<D>, data: any) => {
  try {
    return schema.parse(data);
  } catch (e: any) {
    console.error(`Failed to parse schema.`);
    console.error(JSON.stringify(e?.issues, null, 4));
    throw new Error(`Failed to parse schema.`);
  }
};

export const getNetworkDevices = ({
  oncConfigConfig,
  deviceSchema,
}: {
  oncConfigConfig: ONCConfig["config"];
  deviceSchema: DeviceSchema;
}) => {
  const ports = deviceSchema.ports || [];
  const cpuPort = ports.find((port) => !!port.swConfigCpuName);

  const expectCpuPort = () => {
    if (!cpuPort?.swConfigCpuName) {
      throw new Error(`CPU port not defined`);
    }

    return cpuPort as { name: string; swConfigCpuName: string };
  };

  const schema = z.object({
    name: z.string(),
    type: z.enum(["network", "vlan", "bridge"]),
  });

  const allDevices = [
    ...(!deviceSchema.swConfig
      ? ports.map((port) => ({ name: port.name, type: "network" }))
      : []),
    ...(oncConfigConfig?.network?.device || []).map((device) => ({
      name: device.name,
      type: device.type,
    })),
    ...(oncConfigConfig?.network?.["bridge-vlan"] || []).map((bridgeVlan) => ({
      name: `${bridgeVlan.device}.${bridgeVlan.vlan}`,
      type: "vlan",
    })),
    ...(oncConfigConfig?.network?.["switch_vlan"] || []).map((switchVlan) => {
      const cpuPort = expectCpuPort();
      return {
        name: `${cpuPort.swConfigCpuName}.${switchVlan.vlan}`,
        type: "network",
      };
    }),
    ...(deviceSchema.swConfig
      ? [{ name: expectCpuPort().swConfigCpuName, type: "network" }]
      : []),
  ];

  const parsedDevices = allDevices.map((device) => parseSchema(schema, device));

  return parsedDevices;
};

export const targetSchema = z.string();

export type Target = z.infer<typeof targetSchema>;

export const getExtensionSchema = (schema?: z.ZodObject<any>) => {
  const extensionSchema = z.object({
    target: targetSchema.optional(),
    target_overrides: z
      .array(
        z.object({
          target: targetSchema,
          overrides: schema ? schema.partial() : z.any(),
        })
      )
      .optional(),
  });

  return extensionSchema;
};

const temp = getExtensionSchema();

export type ExtensionSchema = z.infer<typeof temp>;

export const getTargetsExtension = (schema?: z.ZodObject<any, any>) => ({
  ".": getExtensionSchema(schema).optional(),
});

export const sectionSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return z
    .array(
      z
        .object({
          name: z.string().optional(),
          properties: schema,
        })
        .strict()
    )
    .optional();
};

export const oncSectionSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return z
    .array(schema.partial().extend(getTargetsExtension(schema)).strict())
    .optional();
};

export const configSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return schema.optional();
};

export const makeOncConfigSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return schema.extend(getTargetsExtension(schema)).strict();
};
