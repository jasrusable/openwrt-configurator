import { DeviceSchema } from "./deviceSchema";
import {
  configConfigSchema,
  ExtensionSchema,
  ONCConfig,
  ONCDeviceConfig,
  Targets,
} from "./oncConfigSchema";
import { OpenWrtConfig, openWrtConfigSchema } from "./openWrtConfigSchema";
import { omit } from "lodash";
import { parseSchema } from "./utils";

export const getOpenWrtConfig = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const useSwConfig = deviceSchema.swConfig;

  const ports = deviceSchema.ports || [];

  const cpuPort = ports.find((port) => !!port.swConfigCpuName);

  const physicalPorts = ports.filter((port) => !port.swConfigCpuName);

  const radios = deviceSchema.radios || [];

  const targetMatches = (targets?: Targets) => {
    if (!targets) {
      return true;
    }

    if (typeof targets === "string") {
      return targets === "*";
    }

    const tagMatches =
      Array.isArray(targets) &&
      targets.find((target) =>
        deviceConfig.tags.find((tag) =>
          tag.name === target.tag &&
          typeof target.value === "string" &&
          target.value === "*"
            ? true
            : Array.isArray(target.value)
            ? !!target.value.find((val) => tag.value.includes(val))
            : false
        )
      );
    if (tagMatches) {
      return true;
    }

    const optMatches =
      Array.isArray(targets) &&
      targets.find(
        (target) => target.opt === "sw_config" && target.value === useSwConfig
      );

    if (optMatches) {
      return true;
    }

    return false;

    // const matches = targets
    //   ? typeof targets === "string" && targets === "*"
    //     ? true
    //     : targets.find((target) =>
    //         deviceConfig.tags.find((tag) =>
    //           tag.name === target.tag &&
    //           typeof target.value === "string" &&
    //           target.value === "*"
    //             ? true
    //             : Array.isArray(target.value)
    //             ? !!target.value.find((val) => tag.value.includes(val))
    //             : false
    //         )
    //       )
    //   : true;

    // return matches;
  };

  const applyConfig = <S extends Record<string, any>>(section: S) => {
    const sectionConfig = section["."] as ExtensionSchema | undefined;
    const targets = sectionConfig?.targets;
    const matches = targetMatches(targets);
    const overrides = (sectionConfig?.target_overrides || [])
      .filter((override) => {
        return targetMatches(override.targets);
      })
      .reduce((acc, override) => {
        return { ...acc, ...override.overrides };
      }, {});
    return matches ? omit({ ...section, ...overrides }, ".") : {};
  };

  const resolvedOpenWrtConfig = Object.keys(oncConfig.config).reduce(
    (config, configKey) => {
      const a = applyConfig((oncConfig.config as any)[configKey]);
      const resolvedConfig = Object.keys(a).reduce((section, sectionKey) => {
        const sections: any[] = (a as any)[sectionKey] || [];
        const resolvedSections = sections
          .map((section) => {
            const resolvedSection = applyConfig(section);
            return resolvedSection;
          })
          .filter((section) => Object.keys(section).length > 0)
          .map((resolvedSection: any) => {
            return {
              ...(resolvedSection.name ? { name: resolvedSection.name } : {}),
              properties: {
                ...resolvedSection,

                // Add hostname
                ...(configKey === "system" &&
                  sectionKey === "system" && {
                    hostname: deviceConfig.hostname,
                  }),

                // Resolve device ports
                ...(configKey === "network" &&
                  sectionKey === "device" && {
                    ports: (resolvedSection.ports === "*"
                      ? physicalPorts.map((port) => port.name)
                      : resolvedSection.ports
                    ).map((portName: string) => {
                      const vlan = portName.split(".")[1];
                      return portName.startsWith("@cpu_port")
                        ? `${cpuPort?.swConfigCpuName}${vlan ? `.${vlan}` : ""}`
                        : portName;
                    }),
                  }),

                // Resolve bridge-vlan ports
                ...(configKey === "network" &&
                  sectionKey === "bridge-vlan" && {
                    ports: physicalPorts.map((port) => {
                      if (typeof resolvedSection.ports === "string") {
                        return resolvedSection.ports === "*"
                          ? port.name
                          : resolvedSection.ports === "*t"
                          ? `${port.name}:t`
                          : "";
                      } else {
                        return resolvedSection.ports;
                      }
                    }),
                  }),

                // Resolve switch_vlan ports
                ...(configKey === "network" &&
                  sectionKey === "switch_vlan" && {
                    ports: [
                      ...[cpuPort].map((port) => {
                        if (!port?.name) {
                          throw new Error(`CPU port not defined`);
                        }
                        return `${port.name}:t`;
                      }),
                      ...physicalPorts.map((port) => {
                        if (typeof resolvedSection.ports === "string") {
                          return resolvedSection.ports === "*"
                            ? port.name
                            : resolvedSection.ports === "*t"
                            ? `${port.name}:t`
                            : "";
                        } else {
                          return resolvedSection.ports;
                        }
                      }),
                    ]
                      .map((portName) =>
                        portName.replace("eth", "").replace(":", "")
                      )
                      .join(" "),
                  }),

                // Resolve wifi-iface device
                ...(configKey === "wireless" &&
                  sectionKey === "wifi-iface" && {
                    device: "radio0",
                  }),
              },
            };
          });
        return { ...section, [sectionKey]: resolvedSections };
      }, {});
      return { ...config, [configKey]: resolvedConfig };
    },
    {}
  ) as OpenWrtConfig;

  console.log(JSON.stringify(resolvedOpenWrtConfig.network, null, 4));

  const openWrtConfig = parseSchema(openWrtConfigSchema, resolvedOpenWrtConfig);

  return openWrtConfig;
};
