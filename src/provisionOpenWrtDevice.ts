import { OpenWrtConfig } from "./openWrtConfigSchema";
import { NodeSSH } from "node-ssh";
import { builtInRevertCommands, getDeviceScript } from "./getDeviceScript";
import { getBoardJson, getInstalledPackages } from "./utils";

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
  state: {
    config: OpenWrtConfig;
    packagesToInstall?: { packageName: string; version?: string }[];
    packagesToUninstall?: string[];
  };
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

  console.log(`Verifying device... `);
  const boardJson = await getBoardJson(connectedSsh);
  if (boardJson.model.id !== deviceModelId) {
    throw new Error(
      `Mismatching device model id. Expected ${deviceModelId} but found ${boardJson.model.id} in /etc/board.json`
    );
  }
  console.log("Verified.");

  const installedPackages = await getInstalledPackages(connectedSsh);
  const packagesToUninstall = installedPackages
    .filter((packageName) =>
      state.packagesToUninstall?.includes(packageName.packageName)
    )
    .map(({ packageName }) => packageName);
  if (packagesToUninstall.length > 0) {
    console.log("Removing packages...");
    const removeResult = await connectedSsh.execCommand(
      `opkg remove --force-removal-of-dependent-packages ${packagesToUninstall.join(
        " "
      )}`
    );
    if (!removeResult.stdout || removeResult.code !== 0) {
      console.error(removeResult.stderr);
      throw new Error("Failed to remove packages");
    }
    console.log("Removed packages.");
  }

  const packagesToInstall = (state.packagesToInstall || []).filter(
    (package_) => {
      return !installedPackages
        .map((p) => p.packageName)
        ?.includes(package_.packageName);
    }
  );
  if (packagesToInstall.length > 0) {
    console.log("Installing packages...");
    const installResult = await connectedSsh.execCommand(
      `opkg update; opkg install ${packagesToInstall
        .map((p) => p.packageName)
        .join(" ")}`
    );
    if (!installResult.stdout || installResult.code !== 0) {
      console.error(installResult.stderr);
      throw new Error("Failed to install packages");
    }
    console.log("Installed packages.");
  }

  const commands = getDeviceScript({ openWrtConfig: state.config });
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
