import { deviceSchemaSchema } from "./deviceSchema";
import { ONCDeviceConfig } from "./oncConfigSchema";
import {
  boardJson as boardJsonProbe,
  radios as radiosProbe,
  meshSupport,
  runProbes,
  systemBoard,
} from "./deviceProbes";
import { parseDeviceFacts } from "./facts/board";
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
  const raw = await runProbes(ssh, {
    board: boardJsonProbe,
    system: systemBoard,
    uciWireless: radiosProbe,
    meshSupport,
  });
  const deviceSchema = parseSchema(deviceSchemaSchema, parseDeviceFacts(raw));
  (deviceSchema.skipped ?? []).forEach((what) =>
    console.warn(`  ${deviceConfig.hostname}: skipped ${what}.`)
  );
  return deviceSchema;
};
