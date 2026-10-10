import { DeviceSchema, deviceSchemaSchema } from "./deviceSchema";
import { ONCDeviceConfig } from "./oncConfigSchema";
import {
  boardJson as boardJsonProbe,
  radios as radiosProbe,
  release,
  runProbes,
} from "./deviceProbes";
import { Platform, Session } from "./platform";
import { parseJson, parseSchema } from "./utils";

export const getDeviceSchema = async ({
  deviceConfig,
  ssh,
  local,
}: {
  deviceConfig: ONCDeviceConfig;
  /** An already-connected session. Reused so provisioning need not reconnect. */
  ssh?: Session;
  /**
   * Read the schema from the checked-in ./deviceSchemas instead of the device.
   * Only the tests use this, and those files cover just two old models.
   */
  local?: Pick<Platform, "readTextFile">;
}) => {
  if (local) {
    const path = `./deviceSchemas/${deviceConfig.model_id}.json`;
    return parseSchema(
      deviceSchemaSchema,
      parseJson(local.readTextFile(path), path)
    );
  }

  if (!ssh) {
    throw new Error(
      `No SSH session provided for ${deviceConfig.hostname} and no local schemas.`
    );
  }

  // One round trip: each exec is a separate SSH channel (~59ms on a LAN
  // device, a whole client process under QuickJS).
  const {
    boardJson,
    radios,
    release: version,
  } = await runProbes(ssh, {
    boardJson: boardJsonProbe,
    radios: radiosProbe,
    release,
  });

  const isSwConfig = !!boardJson.switch;

  const deviceSchemaTmp: DeviceSchema = {
    name: deviceConfig.model_id,
    version,
    sw_config: isSwConfig,
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
