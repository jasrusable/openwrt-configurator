// What each feature module contributes to the low-level config, and how the
// pieces are combined. Features never see device facts: anything that depends
// on the device is left to a condition or a placeholder ("*" ports,
// "@wan_port") that the engine resolves against the live device.
import { Intent } from "./schema";

type Section = Record<string, unknown>;

export type Fragment = {
  devices?: Section[];
  package_profiles?: { ".if": string; packages: string[] }[];
  configs_to_not_reset?: { ".if": string; configs: string[] }[];
  /** config -> section type -> sections */
  config?: Record<string, Record<string, Section[]>>;
};

export type Feature = (intent: Intent) => Fragment;

const role = (value: string) => `device.tag.role == '${value}'`;
export const everyDevice = "*";
export const onRouter = role("router");
export const onAccessPoints = role("access-point");
export const onDevice = (name: string) => `device.hostname == '${name}'`;
export const onModel = (model: string) => `device.model_id == '${model}'`;

/** The router takes the first address of the home network. */
export const routerAddress = (intent: Intent) =>
  intent.network.subnet.replace(/\.0\/24$/, ".1");

export const merge = (fragments: Fragment[]) =>
  fragments.reduce<Required<Fragment>>(
    (acc, fragment) => ({
      devices: [...acc.devices, ...(fragment.devices || [])],
      package_profiles: [
        ...acc.package_profiles,
        ...(fragment.package_profiles || []),
      ],
      configs_to_not_reset: [
        ...acc.configs_to_not_reset,
        ...(fragment.configs_to_not_reset || []),
      ],
      config: Object.entries(fragment.config || {}).reduce(
        (config, [configKey, types]) => ({
          ...config,
          [configKey]: Object.entries(types).reduce(
            (sections, [type, list]) => ({
              ...sections,
              [type]: [...(sections[type] || []), ...list],
            }),
            config[configKey] || {}
          ),
        }),
        acc.config
      ),
    }),
    { devices: [], package_profiles: [], configs_to_not_reset: [], config: {} }
  );
