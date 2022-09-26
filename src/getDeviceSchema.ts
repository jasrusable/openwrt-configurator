import { NodeSSH } from "node-ssh";
import { DeviceSchema, deviceSchemaSchema } from "./deviceSchema";
import { ONCDeviceConfig } from "./oncConfigSchema";
import { getBoardJson, getRadios, parseSchema } from "./utils";

export const getDeviceSchema = async ({
  deviceConfig,
}: {
  deviceConfig: ONCDeviceConfig;
}) => {
  const ssh = new NodeSSH();
  const connectedSsh = await ssh.connect({
    host: deviceConfig.ipaddr,
    username: deviceConfig.provisioning_config?.ssh_auth.username,
    password: deviceConfig.provisioning_config?.ssh_auth.password,
  });

  const [boardJson, radios] = await Promise.all([
    getBoardJson(connectedSsh),
    getRadios(connectedSsh),
  ]);

  const isSwConfig = !!boardJson.switch;

  const deviceSchemaTmp: DeviceSchema = {
    name: deviceConfig.device_model_id,
    swConfig: isSwConfig,
    ports: isSwConfig
      ? (boardJson.switch || {}).switch0.ports.map((port) => {
          return {
            name: `eth${port.num}`,
            defaultRole: port.role,
            swConfigCpuName: port.device,
          };
        })
      : [
          ...(boardJson.network.lan.ports || []).map((port) => {
            return {
              name: port,
              defaultRole: "lan",
            } as const;
          }),
          ...(boardJson.network.wan.device
            ? [
                {
                  name: boardJson.network.wan.device,
                  defaultRole: "wan",
                } as const,
              ]
            : []),
          ...(boardJson.network.wan.ports || []).map((port) => {
            return {
              name: port,
              defaultRole: "wan",
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
          htmodes: [radio.htmode],
        };
      }),
    }),
  };

  const deviceSchema = parseSchema(deviceSchemaSchema, deviceSchemaTmp);

  if ((deviceSchema.ports || []).length === 0) {
    throw new Error(
      `Found no ports for ${deviceConfig.device_model_id} at ${deviceConfig.ipaddr}. Expected at least one port.`
    );
  }

  if (deviceSchema.swConfig) {
    const cpuPort = (deviceSchema.ports || []).find(
      (port) => !!port.swConfigCpuName
    );
    if (!cpuPort) {
      throw new Error(
        `Found no CPU port for swConfig device ${deviceConfig.device_model_id} at ${deviceConfig.ipaddr}. Expected at least one CPU port.`
      );
    }
  }

  return deviceSchema;
};
