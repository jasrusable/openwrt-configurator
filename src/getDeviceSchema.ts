import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { DeviceSchema, deviceSchemaSchema } from "./deviceSchema";
import { parseSections } from "./getConfigSections";
import { ONCDeviceConfig } from "./oncConfigSchema";
import { getDeviceFacts, parseJson, parseSchema } from "./utils";

const useLocalOverride = false;

export const getDeviceSchema = async ({
  deviceConfig,
  ssh,
  useLocal,
}: {
  deviceConfig: ONCDeviceConfig;
  /** An already-connected session. Reused so provisioning need not reconnect. */
  ssh?: NodeSSH;
  useLocal?: boolean;
}) => {
  // For local testing:
  if (useLocalOverride || useLocal) {
    const schema = parseJson(
      readFileSync(`./deviceSchemas/${deviceConfig.model_id}.json`, "utf-8")
    );
    const deviceSchema = parseSchema(deviceSchemaSchema, schema);
    return deviceSchema;
  }

  if (!ssh) {
    throw new Error(
      `No SSH session provided for ${deviceConfig.hostname} and useLocal was not set.`
    );
  }

  const { boardJson, radios, uciExport, version } = await getDeviceFacts(ssh);
  const configSections = parseSections(uciExport);

  const isSwConfig = !!boardJson.switch;

  const deviceSchemaTmp: DeviceSchema = {
    name: deviceConfig.model_id,
    version,
    sw_config: isSwConfig,
    config_sections: configSections,
    ports: isSwConfig
      ? (boardJson.switch || {}).switch0.ports.map((port) => {
          return {
            name: `eth${port.num}`,
            defaultRole: port.role,
            sw_config_cpu_name: port.device,
          };
        })
      : [
          ...(boardJson.network.lan.ports || []).map((port) => {
            return {
              name: port,
              default_role: "lan",
            } as const;
          }),
          ...(!boardJson.network.lan.ports &&
          (boardJson.network.lan.device === "lan" ||
            boardJson.network.lan.device === "eth0")
            ? [
                {
                  name: boardJson.network.lan.device,
                  default_role: "lan",
                } as const,
              ]
            : []),
          ...(boardJson.network.wan?.device
            ? [
                {
                  name: boardJson.network.wan.device,
                  default_role: "wan",
                } as const,
              ]
            : []),
          ...(boardJson.network.wan?.ports || []).map((port) => {
            return {
              name: port,
              default_role: "wan",
            } as const;
          }),
        ],
    ...(radios.length > 0 && {
      radios: radios.map((radio) => {
        return {
          name: radio[".name"],
          type: radio.type,
          path: radio.path,
          band: radio.band,
        };
      }),
    }),
  };

  const deviceSchema = parseSchema(deviceSchemaSchema, deviceSchemaTmp);

  if ((deviceSchema.ports || []).length === 0) {
    throw new Error(
      `Found no ports for ${deviceConfig.model_id} at ${deviceConfig.ipaddr}. Expected at least one port.`
    );
  }

  if (deviceSchema.sw_config) {
    const cpuPort = (deviceSchema.ports || []).find(
      (port) => !!port.sw_config_cpu_name
    );
    if (!cpuPort) {
      throw new Error(
        `Found no CPU port for swConfig device ${deviceConfig.model_id} at ${deviceConfig.ipaddr}. Expected at least one CPU port.`
      );
    }
  }

  return deviceSchema;
};
