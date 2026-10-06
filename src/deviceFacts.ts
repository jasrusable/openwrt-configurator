import { z } from "zod";
import { allHtModes, wifiBands, wifiTypes } from "./openWrtValues";
import { Session } from "./platform";
import { parseJson, parseSchema } from "./utils";

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

export const getBoardJson = async (ssh: Session) => {
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
export const getDeviceFacts = async (ssh: Session) => {
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
export const getInstalledPackages = async (ssh: Session) => {
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

export const getManagedFiles = async (ssh: Session, manifestPath: string) => {
  const result = await ssh.execCommand(`cat ${manifestPath} 2>/dev/null`);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/**
 * Everything `apk del --rdepends` would actually take with it.
 *
 * The named packages are only the start: `--rdepends` also removes whatever
 * depends on them. Removing `firewall4` on a stock image pulls 21 packages,
 * `uhttpd` and the whole LuCI stack among them. Reporting only what the config
 * names would understate that badly, so ask apk to simulate it.
 */
export const getRemovalCascade = async ({
  ssh,
  packages,
}: {
  ssh: Session;
  packages: string[];
}) => {
  if (packages.length === 0) {
    return [];
  }

  const result = await ssh.execCommand(
    `apk del --simulate --rdepends ${packages.join(" ")}`
  );

  const cascade = result.stdout
    .split("\n")
    .map((line) => line.match(/^\(\s*\d+\/\d+\)\s+Purging\s+(\S+)\s/))
    .flatMap((match) => (match ? [match[1]] : []));

  // If the simulation could not be parsed, fall back to the named packages
  // rather than reporting an empty, falsely reassuring list.
  return cascade.length > 0 ? cascade : packages;
};
