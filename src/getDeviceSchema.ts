import { deviceSchemaSchema } from "./deviceSchema";
import { PlanDevice } from "./plan/types";
import {
  boardJson as boardJsonProbe,
  radios as radiosProbe,
  meshSupport,
  Probe,
  runProbes,
  systemBoard,
} from "./deviceProbes";
import { parseDeviceFacts } from "./facts/board";
import { Platform, Session } from "./platform";
import { parseJson, parseSchema } from "./utils";

/**
 * Each wiphy's enabled frequencies (MHz) and, where it has several radios,
 * each radio's ranges (kHz), by name: what OpenWrt's own wifi-detect reads,
 * through ucode's nl80211 module (iw may be absent). Nothing where ucode or
 * the module is missing: unknown, and a radio then takes its band's first.
 */
const wiphyChannels: Probe<unknown> = {
  command: `ucode -e 'import * as nl from "nl80211"; let d = nl.request(nl.const.NL80211_CMD_GET_WIPHY, nl.const.NLM_F_DUMP, { split_wiphy_dump: true }) ?? []; let names = {}, freqs = {}, radios = {}; for (let w in d) { if (!w) continue; let i = w.wiphy; if (w.wiphy_name) names[i] = w.wiphy_name; if (!freqs[i]) freqs[i] = []; if (!radios[i]) radios[i] = []; for (let b in w.wiphy_bands) { if (!b || !b.freqs) continue; for (let f in b.freqs) if (!f.disabled) push(freqs[i], f.freq); } for (let r in w.radios) push(radios[i], { index: r.index, ranges: map(r.freq_ranges, (x) => [x.start, x.end]) }); } let o = {}; for (let i in names) o[names[i]] = { freqs: freqs[i], radios: radios[i] }; print(o);' 2>/dev/null || echo '{}'`,
  parse: ({ stdout }) => {
    try {
      return parseJson(stdout.trim() || "{}");
    } catch {
      return {};
    }
  },
};

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
  wiphys: wiphyChannels,
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
