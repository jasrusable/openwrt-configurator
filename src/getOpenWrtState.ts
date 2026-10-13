import { DeviceSchema } from "./deviceSchema";
import { getOpenWrtConfig } from "./getOpenWrtConfig";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { OpenWrtState } from "./openWrtConfigSchema";
import { conditionMatches } from "./resolveOncConfig";

export const getOpenWrtState = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const openWrtConfig = getOpenWrtConfig({
    oncConfig,
    deviceConfig,
    deviceSchema,
  });

  const packages = (oncConfig.package_profiles || [])
    .filter((packageProfile) => {
      return conditionMatches({
        condition: packageProfile[".if"],
        deviceConfig,
        deviceSchema,
      });
    })
    .reduce<string[]>((acc, packageProfile) => {
      return [...new Set([...acc, ...packageProfile.packages])];
    }, []);

  // A leading "-" removes; the schema allows nothing else (no version pins).
  const packagesToInstall = packages.filter((name) => !name.startsWith("-")).map((packageName) => ({ packageName }));
  const packagesToUninstall = packages.filter((name) => name.startsWith("-")).map((name) => name.slice(1));

  // What the wipe leaves alone. The rest is worked out against the device's
  // actual config, read after the package step (see getStageCommands).
  const configsToNotReset = (oncConfig.configs_to_not_reset || [])
    .filter((a) => {
      return conditionMatches({
        condition: a[".if"],
        deviceConfig,
        deviceSchema,
      });
    })
    .flatMap((a) => a.configs);

  // One entry per service: running if any declaration says so, and off
  // only if every declaration says so.
  const services = (oncConfig.services || [])
    .filter((service) =>
      conditionMatches({ condition: service[".if"], deviceConfig, deviceSchema })
    )
    .reduce<{ name: string; running: boolean; enabled?: boolean; restart_after_rollback?: boolean }[]>(
      (acc, { name, running, enabled, restart_after_rollback }) => {
        const on = enabled !== false;
        const known = acc.find((s) => s.name === name);
        const restart = !!restart_after_rollback || !!known?.restart_after_rollback;
        const merged = {
          ...(known
            ? { name, running: known.running || !!running, ...(known.enabled === false && !on ? { enabled: false } : {}) }
            : { name, running: !!running, ...(on ? {} : { enabled: false }) }),
          ...(restart ? { restart_after_rollback: true } : {}),
        };
        return known ? acc.map((s) => (s.name === name ? merged : s)) : [...acc, merged];
      },
      []
    );

  // Resolve files (conditional via `.if`), de-duped by path with last-one-wins.
  const filesMap = new Map<
    string,
    {
      path: string;
      content: string;
      mode?: string;
      run_after?: string;
      run_after_reload?: string;
    }
  >();
  (oncConfig.files || [])
    .filter((file) => {
      return conditionMatches({
        condition: file[".if"],
        deviceConfig,
        deviceSchema,
      });
    })
    .forEach((file) => {
      filesMap.set(file.path, {
        path: file.path,
        content: file.content,
        mode: file.mode,
        run_after: file.run_after,
        run_after_reload: file.run_after_reload,
      });
    });
  const files = [...filesMap.values()];

  const openWrtState: OpenWrtState = {
    config: openWrtConfig,
    packagesToInstall,
    packagesToUninstall,
    configsToNotReset,
    services,
    files,
  };

  return openWrtState;
};
