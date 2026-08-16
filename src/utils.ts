import { NodeSSH } from "node-ssh";
import { z, ZodError, ZodObject, ZodRawShape, ZodSchema } from "zod";
import { DeviceSchema } from "./deviceSchema";
import { ONCConfig } from "./oncConfigSchema";
import { allHtModes, wifiBands, wifiTypes } from "./openWrtValues";
import parseJsonF from "parse-json";

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
    wan: z
      .object({
        device: z.string().optional(),
        protocol: z.string(),
        ports: z.array(z.string()).optional(),
      })
      .optional(),
  }),
});

export const getBoardJson = async (ssh: NodeSSH) => {
  const boardJsonPath = "/etc/board.json";
  const boardJsonResult = await ssh.execCommand(`cat ${boardJsonPath}`);
  if (!boardJsonResult.stdout || boardJsonResult.code !== 0) {
    throw new Error(`Failed to verify ${boardJsonPath} file.`);
  }
  const boardJson = parseSchema(
    boardJsonSchema,
    parseJson(boardJsonResult.stdout, boardJsonPath)
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


/**
 * Everything `getDeviceSchema` needs, in a single SSH exec.
 *
 * Each exec is a separate SSH channel (~59ms against a LAN device), so issuing
 * these four separately costs four round trips even when wrapped in
 * `Promise.all` — they share one connection and cannot overlap.
 */
export const getDeviceFacts = async (ssh: NodeSSH) => {
  const sep = "__ONC_FACT__";
  const result = await ssh.execCommand(
    [
      `cat /etc/board.json`,
      `echo "${sep}"`,
      `ubus call uci get '{"config": "wireless", "type": "wifi-device"}' 2>/dev/null || echo '{"values":{}}'`,
      `echo "${sep}"`,
      `uci export`,
      `echo "${sep}"`,
      `cat /etc/openwrt_release`,
    ].join("\n")
  );

  const parts = result.stdout.split(`${sep}\n`);
  if (parts.length !== 4) {
    console.error(result.stderr);
    throw new Error(
      `Failed to read device facts (expected 4 sections, got ${parts.length}).`
    );
  }

  const [boardJsonRaw, radiosRaw, uciExport, releaseRaw] = parts;

  const boardJson = parseSchema(
    boardJsonSchema,
    parseJson(boardJsonRaw, "/etc/board.json")
  );

  const parsedRadios = parseSchema(wirelessConfigSchema, parseJson(radiosRaw));
  const radios = Object.values(parsedRadios.values);

  const distribReleaseLine = releaseRaw
    .split("\n")
    .find((line) => line.startsWith("DISTRIB_RELEASE"));
  if (!distribReleaseLine) {
    throw new Error(
      "Failed to determine device version in /etc/openwrt_release"
    );
  }
  const version = distribReleaseLine.split("=")[1].replace(/'/g, "");

  return { boardJson, radios, uciExport, version };
};

/**
 * Names of the packages installed on the device.
 *
 * Uses `apk info`, which prints one bare package name per line. The previous
 * approach parsed `apk list --installed` by splitting on the last "-", which
 * silently mangled any name carrying an apk release suffix: `curl-8.19.0-r2`
 * parsed as name "curl-8.19.0", version "r2". That mis-parsed 86% of packages
 * on a stock 25.12 install, so the installed-set comparisons below it never
 * matched: removals were filtered away entirely and installs were re-issued on
 * every provision.
 */
export const getInstalledPackages = async (ssh: NodeSSH) => {
  const command = await ssh.execCommand(`apk info`);
  if (command.code !== 0) {
    if (command.stderr === "Command failed: Not found") {
      return [];
    }
    console.error(command.stderr);
    throw new Error("Failed to get installed packages");
  }

  return command.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

export const getManagedFiles = async (ssh: NodeSSH, manifestPath: string) => {
  const result = await ssh.execCommand(`cat ${manifestPath} 2>/dev/null`);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};


export const parseSchema = <D>(schema: ZodSchema<D>, data: any) => {
  try {
    return schema.parse(data);
  } catch (e: any) {
    const issues = e?.issues;
    const parsedIssues = issues
      ? issues.map((issue: any) => ({
          message: issue.message,
          path: issue.path.join("."),
          code: issue.code,
        }))
      : undefined;
    throw new Error(
      `Failed to parse schema. ${
        parsedIssues
          ? `Parsing issues: ${JSON.stringify(parsedIssues, null, 4)}`
          : ""
      }`
    );
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
  const cpuPort = ports.find((port) => !!port.sw_config_cpu_name);

  const expectCpuPort = () => {
    if (!cpuPort?.sw_config_cpu_name) {
      throw new Error(`CPU port not defined`);
    }

    return cpuPort as { name: string; swConfigCpuName: string };
  };

  const schema = z.object({
    name: z.string(),
    type: z.enum(["network", "vlan", "bridge"]),
  });

  const allDevices = [
    ...(!deviceSchema.sw_config
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
    ...(deviceSchema.sw_config
      ? [{ name: expectCpuPort().swConfigCpuName, type: "network" }]
      : []),
  ];

  const parsedDevices = allDevices.map((device) => parseSchema(schema, device));

  return parsedDevices;
};

export const conditionSchema = z.string();

export type Condition = z.infer<typeof conditionSchema>;

export const getExtensionObject = (schema?: z.ZodObject<any>) => {
  const extensionObject = {
    ".if": conditionSchema.optional(),
    ".overrides": z
      .array(
        z.object({
          ".if": conditionSchema,
          override: schema ? schema.partial() : z.any(),
        })
      )
      .optional(),
  };

  return extensionObject;
};

export const getExtensionSchema = (schema?: z.ZodObject<any>) => {
  const extensionSchema = z.object(getExtensionObject(schema));
  return extensionSchema;
};

const temp = getExtensionSchema();

export type ExtensionSchema = z.infer<typeof temp>;

export const getConditionalExtension = (schema?: z.ZodObject<any, any>) =>
  getExtensionSchema(schema).optional();

export const sectionSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return z.array(schema.extend({ ".name": nameValidation })).optional();
};

/**
 * A section name reaches `uci batch` as an unquoted identifier, and uci's
 * tokenizer terminates unquoted tokens at whitespace and at `#`. The previous
 * pattern was unanchored, so it only required the name to *contain* one
 * alphanumeric — `foo bar` and `foo#bar` passed here and failed mid-provision
 * instead of at parse time with a usable message.
 */
export const nameValidation = z
  .string()
  .regex(
    /^[0-9a-zA-Z_-]+$/,
    "must contain only letters, digits, underscores or hyphens"
  );

export const oncSectionSchema = <T extends ZodRawShape>(
  schema: ZodObject<T, any>
) => {
  return z
    .array(
      schema.partial().extend({
        ".name": nameValidation.optional(),
        ...getExtensionObject(schema),
      })
    )
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
  return schema.extend(getExtensionObject(schema));
};

export const parseJson = (jsonString: string, filepath?: string) => {
  return parseJsonF(jsonString, filepath);
};
