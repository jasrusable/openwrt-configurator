import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { conditionMatches } from "./resolveOncConfig";
import { utf8ByteLength } from "./utf8";
import { shellQuote } from "./shell";

/** An image is built for a model, so a device to build for must name one. */
type BuildDevice = ONCDeviceConfig & { model_id: string };

const requireModelId = (deviceConfig: ONCDeviceConfig): BuildDevice => {
  if (!deviceConfig.model_id) {
    throw new Error(
      `${deviceConfig.hostname} has no model_id. build-images needs one per ` +
        `device: there is no live device to read it from.`
    );
  }
  return { ...deviceConfig, model_id: deviceConfig.model_id };
};

const BOOTSTRAP_MARKER = "/etc/openwrt-configurator-bootstrapped";
const UCI_DEFAULTS_MAX_BYTES = 20480;

export const buildModeDeviceSchema = (
  deviceConfig: BuildDevice
): DeviceSchema => ({
  name: deviceConfig.model_id,
  version: "build-time",
  ports: [],
});

const matches = (
  condition: string | undefined,
  deviceConfig: BuildDevice,
  deviceSchema: DeviceSchema
) => conditionMatches({ condition, deviceConfig, deviceSchema });

const applyOverridesScalar = <T>({
  base,
  overrides,
  deviceConfig,
  deviceSchema,
  pick,
}: {
  base: T;
  overrides?: Array<{ ".if": string; override: any }>;
  deviceConfig: BuildDevice;
  deviceSchema: DeviceSchema;
  pick: (override: any) => T;
}): T => {
  return (overrides || [])
    .filter((o) => matches(o[".if"], deviceConfig, deviceSchema))
    .reduce<T>((acc, o) => pick(o.override) ?? acc, base);
};

export const resolveVersion = ({
  oncConfig,
  deviceConfig,
}: {
  oncConfig: ONCConfig;
  deviceConfig: BuildDevice;
}): string => {
  if (!oncConfig.version) {
    throw new Error(
      `No "version" set on the config. Add a top-level "version" field (e.g. "23.05.5") to build images.`
    );
  }
  if (typeof oncConfig.version === "string") {
    return oncConfig.version;
  }
  const deviceSchema = buildModeDeviceSchema(deviceConfig);
  return applyOverridesScalar({
    base: oncConfig.version[".value"],
    overrides: oncConfig.version[".overrides"],
    deviceConfig,
    deviceSchema,
    pick: (o) => o[".value"],
  });
};

export const resolvePackages = ({
  oncConfig,
  deviceConfig,
}: {
  oncConfig: ONCConfig;
  deviceConfig: BuildDevice;
}): string[] => {
  const deviceSchema = buildModeDeviceSchema(deviceConfig);
  return (oncConfig.package_profiles || [])
    .filter((p) => matches(p[".if"], deviceConfig, deviceSchema))
    .reduce<string[]>((acc, p) => [...new Set([...acc, ...p.packages])], [])
    .map((entry) => entry.split("@")[0]);
};

const resolveSection = ({
  section,
  deviceConfig,
  deviceSchema,
}: {
  section: any;
  deviceConfig: BuildDevice;
  deviceSchema: DeviceSchema;
}) => {
  if (!matches(section?.[".if"], deviceConfig, deviceSchema)) {
    return undefined;
  }
  const overridden = (section?.[".overrides"] || [])
    .filter((o: any) => matches(o[".if"], deviceConfig, deviceSchema))
    .reduce((acc: any, o: any) => ({ ...acc, ...o.override }), {});
  return Object.fromEntries(
    Object.entries({ ...section, ...overridden }).filter(
      ([k]) => ![".if", ".overrides"].includes(k)
    )
  );
};

export const resolveLanInterface = ({
  oncConfig,
  deviceConfig,
}: {
  oncConfig: ONCConfig;
  deviceConfig: BuildDevice;
}) => {
  const deviceSchema = buildModeDeviceSchema(deviceConfig);
  const interfaces: any[] = (oncConfig.config?.network as any)?.interface || [];
  const lan = interfaces.find((iface) => iface[".name"] === "lan");
  if (!lan) {
    return undefined;
  }
  const resolved = resolveSection({
    section: lan,
    deviceConfig,
    deviceSchema,
  });
  if (!resolved) return undefined;
  delete (resolved as any)[".name"];
  return resolved as {
    proto?: string;
    ipaddr?: string;
    netmask?: string;
  } & Record<string, unknown>;
};

export const resolveTimezone = ({
  oncConfig,
  deviceConfig,
}: {
  oncConfig: ONCConfig;
  deviceConfig: BuildDevice;
}): { timezone?: string; zonename?: string } => {
  const deviceSchema = buildModeDeviceSchema(deviceConfig);
  const systemSections: any[] = (oncConfig.config?.system as any)?.system || [];
  const merged = systemSections
    .map((s) => resolveSection({ section: s, deviceConfig, deviceSchema }))
    .filter((s): s is Record<string, unknown> => !!s)
    .reduce((acc, s) => ({ ...acc, ...s }), {} as Record<string, unknown>);
  return {
    timezone: typeof merged.timezone === "string" ? merged.timezone : undefined,
    zonename: typeof merged.zonename === "string" ? merged.zonename : undefined,
  };
};

export const getUciDefaultsScript = ({
  timezone,
  zonename,
  lan,
  redact,
}: {
  timezone?: string;
  zonename?: string;
  lan?: Record<string, unknown>;
  /**
   * Applied before shellQuote. Quoting turns an apostrophe into `'\''`, so
   * redacting the finished script can no longer see the value as one span.
   */
  redact?: (value: string) => string;
}): string => {
  const quoted = (value: string) => shellQuote(redact ? redact(value) : value);
  const lines: string[] = [
    "#!/bin/sh",
    "# Generated by openwrt-configurator. Idempotent: re-runs are safe.",
    `if [ -f ${BOOTSTRAP_MARKER} ]; then exit 0; fi`,
    "set -e",
    "",
    "uci batch <<'__UCI__'",
  ];

  const systemLines: string[] = [];
  if (timezone) {
    systemLines.push(`set system.@system[0].timezone=${quoted(timezone)}`);
  }
  if (zonename) {
    systemLines.push(`set system.@system[0].zonename=${quoted(zonename)}`);
  }
  if (systemLines.length > 0) {
    lines.push(...systemLines, "commit system");
  }

  if (lan) {
    const lanLines: string[] = [];
    if (typeof lan.proto === "string") {
      lanLines.push(`set network.lan.proto=${quoted(lan.proto)}`);
    }
    if (typeof lan.ipaddr === "string") {
      lanLines.push(`set network.lan.ipaddr=${quoted(lan.ipaddr)}`);
    }
    if (typeof lan.netmask === "string") {
      lanLines.push(`set network.lan.netmask=${quoted(lan.netmask)}`);
    }
    if (typeof lan.gateway === "string") {
      lanLines.push(`set network.lan.gateway=${quoted(lan.gateway)}`);
    }
    if (lanLines.length > 0) {
      lines.push(...lanLines, "commit network");
    }
  }

  lines.push("__UCI__", "", `touch ${BOOTSTRAP_MARKER}`, "exit 0", "");

  const script = lines.join("\n");
  if (utf8ByteLength(script) > UCI_DEFAULTS_MAX_BYTES) {
    throw new Error(
      `Generated UCI defaults script exceeds ASU limit of ${UCI_DEFAULTS_MAX_BYTES} bytes.`
    );
  }
  return script;
};

export type DeviceBuildPlan = {
  deviceConfig: BuildDevice;
  version: string;
  packages: string[];
  uciDefaults: string;
};

export const getDeviceBuildPlan = ({
  oncConfig,
  deviceConfig: unchecked,
  redact,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  redact?: (value: string) => string;
}): DeviceBuildPlan => {
  const deviceConfig = requireModelId(unchecked);
  const version = resolveVersion({ oncConfig, deviceConfig });
  const packages = resolvePackages({ oncConfig, deviceConfig });
  const lan = resolveLanInterface({ oncConfig, deviceConfig });
  const { timezone, zonename } = resolveTimezone({ oncConfig, deviceConfig });
  const uciDefaults = getUciDefaultsScript({
    timezone,
    zonename,
    lan,
    redact,
  });
  return { deviceConfig, version, packages, uciDefaults };
};
