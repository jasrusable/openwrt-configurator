import { OpenWrtConfig } from "./openWRTConfigSchema";
import { NodeSSH } from "node-ssh";
import { getLuciCommands } from "./getLuciCommands";
import { resetCommands, revertCommands } from "./getDeviceScript";
import { getBoardJson, getDeviceVersion } from "./utils";

export const provisionOpenWRTDevice = async ({
  deviceId,
  deviceVersion,
  auth,
  ipAddress,
  openWRTConfig,
}: {
  deviceId: string;
  deviceVersion: string;
  auth: {
    username: string;
    password: string;
  };
  ipAddress: string;
  openWRTConfig: OpenWrtConfig;
}) => {
  console.log(`Provisioning ${auth.username}@${ipAddress}...`);
  const ssh = new NodeSSH();

  console.log(`Connecting...`);
  const connectedSsh = await ssh.connect({
    host: ipAddress,
    username: auth.username,
    password: auth.password,
  });
  console.log(`Connected.`);

  console.log(`Verifying device version...`);
  const version = await getDeviceVersion(connectedSsh);
  if (version !== deviceVersion) {
    throw new Error(
      `Mismatching device version Expected ${deviceVersion} but found ${version}`
    );
  }
  console.log("Verified.");

  console.log(`Verifying device... `);
  const boardJson = await getBoardJson(connectedSsh);
  if (boardJson.model.id !== deviceId) {
    throw new Error(
      `Mismatching device id. Expected ${deviceId} but found ${boardJson.model.id} in /etc/board.json`
    );
  }
  console.log("Verified.");

  const luciCommands = getLuciCommands({ openWRTConfig });

  const commandsToRun = [
    ...resetCommands,
    ...luciCommands,
    "uci commit",
    "reload_config",
  ];

  console.log("Provisioning...");
  for (const command of commandsToRun) {
    const result = await connectedSsh.execCommand(command);
    if (result.code !== 0) {
      console.error(
        `Command failed with exit code: ${result.code}: ${command}`
      );
      console.error(`${result.stderr}`);

      console.error(`Reverting...`);
      for (const revertCommand of revertCommands) {
        const revertResult = await connectedSsh.execCommand(revertCommand);
        if (revertResult.code !== 0) {
          console.error(`Failed to revert with command: ${revertCommand}`);
          console.error(`${revertResult.stderr}`);
        }
      }
      console.error(`Reverted.`);

      throw new Error(
        `Failed to provision. Command ${command} failed. Aborting and rolling back.`
      );
    }
  }

  console.log("Provisioning completed.");
};
