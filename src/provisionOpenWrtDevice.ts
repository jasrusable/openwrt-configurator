import { OpenWrtState } from "./openWrtConfigSchema";
import { NodeSSH } from "node-ssh";
import { builtInRevertCommands, getDeviceScript } from "./getDeviceScript";
import { getBoardJson } from "./utils";

export const provisionOpenWrtDevice = async ({
  deviceModelId,
  ipAddress,
  auth,
  state,
}: {
  deviceModelId: string;
  ipAddress: string;
  auth: {
    username: string;
    password: string;
  };
  state: OpenWrtState;
}) => {
  console.log(`Provisioning ${auth.username}@${ipAddress}...`);
  const ssh = new NodeSSH();

  console.log(`Connecting over SSH...`);
  const connectedSsh = await ssh.connect({
    host: ipAddress,
    username: auth.username,
    password: auth.password,
  });
  console.log(`Connected.`);

  console.log(`Verifying device...`);
  const boardJson = await getBoardJson(connectedSsh);
  if (boardJson.model.id !== deviceModelId) {
    throw new Error(
      `Mismatching device model id. Expected ${deviceModelId} but found ${boardJson.model.id} in /etc/board.json`
    );
  }
  console.log("Verified.");

  const commands = await getDeviceScript({ state, ssh: connectedSsh });
  console.log("Setting configuration...");
  for (const command of commands) {
    const result = await connectedSsh.execCommand(command);
    if (result.code !== 0) {
      console.error(
        `Command failed with exit code: ${result.code}: ${command}`
      );
      console.error(`${result.stderr}`);
      console.error(`Reverting...`);
      for (const revertCommand of builtInRevertCommands) {
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
  console.log("Configuration set.");

  console.log("Provisioning completed.");
};
