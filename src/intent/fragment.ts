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
  /** Services kept enabled and started; `running` ones must have a process. */
  services?: { ".if": string; name: string; running?: boolean; enabled?: boolean; restart_after_rollback?: boolean }[];
  /** config -> section type -> sections */
  config?: Record<string, Record<string, Section[]>>;
  /** Files a package reads that are not UCI, e.g. avahi's config. */
  files?: {
    ".if": string;
    path: string;
    content: string;
    mode?: string;
    run_after?: string;
    /** After the reload, over a fresh session: for what the reload resets. */
    run_after_reload?: string;
  }[];
};

export type Feature = (intent: Intent) => Fragment;

const role = (value: string) => `device.tag.role == '${value}'`;
export const everyDevice = "*";
export const onRouter = role("router");
export const onAccessPoints = role("access-point");
export const onDevice = (name: string) => `device.hostname == '${name}'`;
export const onModel = (model: string) => `device.model_id == '${model}'`;

export type Network = Intent["networks"][number];

/** The untagged network: the one devices are managed over. */
export const mainNetwork = (intent: Intent) =>
  intent.networks.find((n) => n.vlan === undefined)!;

/** The router takes the first address of each network. */
export const gatewayOf = (network: Network) =>
  network.subnet.replace(/\.0\/24$/, ".1");

/** The router's address on the main network: how it is managed. */
export const routerAddress = (intent: Intent) => gatewayOf(mainNetwork(intent));

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
      services: [...acc.services, ...(fragment.services || [])],
      files: [...acc.files, ...(fragment.files || [])],
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
    { devices: [], package_profiles: [], configs_to_not_reset: [], services: [], files: [], config: {} }
  );

/**
 * A service its feature runs when used, else installed but off: stopped and
 * disabled. An empty or disabled config is not always nothing (https-dns-proxy
 * kept a resolver and a firewall table, usteer ran despite enabled 0, mwan3
 * marked every packet; verified on 25.12.5).
 */
export const serviceWhen = (condition: string, name: string, used: boolean) =>
  used ? { ".if": condition, name, running: true } : { ".if": condition, name, enabled: false };
