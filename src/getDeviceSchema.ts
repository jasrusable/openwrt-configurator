import { deviceSchemaSchema } from "./deviceSchema";
import { PlanDevice } from "./plan/types";
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

/**
 * What a device's schema is read from, in one round trip: each exec is a
 * separate SSH channel (~59ms on a LAN device, a whole client process under
 * QuickJS), so a caller with more to ask adds its probes to these.
 */
export const deviceSchemaProbes = {
  board: boardJsonProbe,
  system: systemBoard,
  uciWireless: radiosProbe,
  meshSupport,
};

/** The schema from what `deviceSchemaProbes` read; what was skipped is said. */
export const deviceSchemaOf = (
  hostname: string,
  raw: Awaited<ReturnType<typeof runProbes<typeof deviceSchemaProbes>>>
) => {
  const deviceSchema = parseSchema(deviceSchemaSchema, parseDeviceFacts(raw));
  (deviceSchema.skipped ?? []).forEach((what) => console.warn(`  ${hostname}: skipped ${what}.`));
  return deviceSchema;
};

export const getDeviceSchema = async ({
  deviceConfig,
  ssh,
  local,
}: {
  deviceConfig: PlanDevice;
  /** An already-connected session. Reused so provisioning need not reconnect. */
  ssh?: Session;
  /**
   * Read the schema from the checked-in ./deviceSchemas instead of the device.
   * Only the tests use this: four models (two old, two captured from devices).
   */
  local?: Pick<Platform, "readTextFile">;
}) => {
  if (local) {
    const path = `./deviceSchemas/${deviceConfig.modelId}.json`;
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

  return deviceSchemaOf(deviceConfig.hostname, await runProbes(ssh, deviceSchemaProbes));
};
