import isValidHostname from "is-valid-hostname";
import { z } from "zod";
// @ts-ignore
import timezoneValidator from "timezone-validator";

export const getDeviceConfigSchema = (params?: {
  schema: DeviceSchema;
  abstractConfig: any;
}) => {
  const { schema, abstractConfig } = params || {};

  const portNames = schema
    ? (schema.ports || [])
        .filter((port) => port.role !== "cpu")
        .map((port) => port.name)
    : undefined;

  const portRefinement = [
    (portName: string) => {
      if (portNames) {
        return portNames.includes(portName);
      }
      return true;
    },
    {
      message: `Port must be a valid port, one of: ${(portNames || []).join(
        ", "
      )}`,
    },
  ] as const;

  const portsUniquenessRefinement: z.Refinement<string[]> = (
    portNames,
    ctx
  ) => {};

  const deviceConfigSchema = z.object({
    target: z.object({
      deviceId: z.string(),
      openWrtVersion: z.string(),
    }),
    system: z.object({
      hostname: z.string().refine((value) => isValidHostname(value), {
        message: "Must be a valid hostname.",
      }),
      timezone: z.string().refine((value) => timezoneValidator(value), {
        message: "Must be a valid timezone.",
      }),
    }),
    network: z.object({
      devices: z.array(
        z
          .object({
            name: z.string(),
            type: z.enum(["bridge"]),
            ports: z
              .array(z.string().refine(...portRefinement))
              .superRefine((portNames, ctx) => {
                const uniquePortNames = [...new Set(portNames)];
                if (portNames.length !== uniquePortNames.length) {
                  const duplicates = portNames.filter(
                    (e, i, a) => a.indexOf(e) !== i
                  );

                  ctx.addIssue({
                    code: "custom",
                    message: `Ports must be uniquely specified, the following are duplicated: ${duplicates.join(
                      ", "
                    )}`,
                  });
                }
              }),
            vlans: z
              .array(
                z.object({
                  id: z.number(),
                  ports: z
                    .array(
                      z.object({
                        name: z.string().refine(...portRefinement),
                        status: z.enum(["tagged", "untagged", "off"]),
                      })
                    )
                    .superRefine((ports, ctx) => {
                      const portNames = ports.map((port) => port.name);
                      const uniquePortNames = [...new Set(portNames)];
                      if (portNames.length !== uniquePortNames.length) {
                        const duplicates = portNames.filter(
                          (e, i, a) => a.indexOf(e) !== i
                        );

                        ctx.addIssue({
                          code: "custom",
                          message: `Ports must be uniquely specified, the following are duplicated: ${duplicates.join(
                            ", "
                          )}`,
                        });
                      }
                    }),
                })
              )
              .superRefine((vlans, ctx) => {
                // Ensure vlan ids are unique.
                const vlanIds = vlans.map((vlan) => vlan.id);
                const uniqueVlansIds = [...new Set(vlanIds)];
                if (uniqueVlansIds.length !== vlanIds.length) {
                  const duplicates = vlanIds.filter(
                    (e, i, a) => a.indexOf(e) !== i
                  );
                  ctx.addIssue({
                    code: "custom",
                    message: `Vlan ids must be unique, the following are duplicated: ${duplicates.join(
                      ", "
                    )}`,
                  });
                }
              })
              .optional(),
          })
          .superRefine((device, ctx) => {
            const vlans = device.vlans || [];

            // Ensure vlan ports are a subset of the device ports.
            vlans.forEach((vlan) => {
              vlan.ports.forEach((port) => {
                if (!device.ports.includes(port.name)) {
                  ctx.addIssue({
                    code: "custom",
                    message: `Port is not specified on device: ${
                      port.name
                    }. Must be one of: ${device.ports.join(", ")}`,
                  });
                }
              });
            });

            // Ensure untagged vlan ports are unique.
            const allUntaggedPorts = vlans.reduce<string[]>((acc, vlan) => {
              const untaggedPortNames = vlan.ports
                .filter((port) => port.status === "untagged")
                .map((port) => port.name);

              acc.forEach((portName) => {
                if (untaggedPortNames.includes(portName)) {
                  ctx.addIssue({
                    code: "custom",
                    message: `Untagged ports must be unique across all vlans. Port ${portName} is untagged in multiple vlans.`,
                  });
                }
              });

              return [...acc, ...untaggedPortNames];
            }, []);
          })
      ),
      interfaces: z.array(
        z.object({
          // General settings
          name: z.string(),
          device: z.string(),
          bringUpAtBoot: z.boolean().optional(),
          forceLink: z.boolean().optional(),
          useDefaultGateway: z.boolean().optional(),
          proto: z.enum(["dhcp", "static"]),

          // Static settings
          // ipv4
          ipv4Address: z.string().optional(),
          ipv4NetMask: z.string().optional(),
          ipv4Gateway: z.string().optional(),
          ipv4Broadcast: z.string().optional(),
          // ipv6
          ipv6Addresses: z.array(z.string()).optional(),
          ipv6Gateway: z.string().optional(),
          ipv6Prefix: z.string().optional(),
        })
      ),
    }),
    wireless: z.object({
      radios: z.array(
        z.object({
          name: z.string(),
          channel: z.number(),
          disabled: z.boolean().optional(),
          cellDensity: z
            .enum(["disabled", "normal", "high", "veryHigh"])
            .optional(),
        })
      ),
      networks: z.array(
        z.object({
          device: z.string(),
          mode: z.enum(["ap"]),
          ssid: z.string().optional(),
          encryption: z
            .enum([
              "sae",
              "sae-mixed",
              "psk2",
              "psk-mixed",
              "psk",
              "none",
              "owe",
            ])
            .optional(),
          key: z.string().optional(),
          network: z.string().optional(),
          wmm: z.boolean().optional(),
        })
      ),
    }),
  });

  return deviceConfigSchema;
};

const deviceConfigSchema = getDeviceConfigSchema();
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;

export const parseDeviceConfig = ({
  schema,
  config,
}: {
  schema: DeviceSchema;
  config: any;
}) => {
  const abstractDeviceConfigSchema = getDeviceConfigSchema();
  const abstractConfig = abstractDeviceConfigSchema.parse(config);
  const deviceConfigSchema = getDeviceConfigSchema({ schema, abstractConfig });
  const parsedConfig = deviceConfigSchema.parse(config);
  return parsedConfig;
};

export const deviceSchema = z.object({
  name: z.string(),
  flags: z.object({
    dsa: z.string(),
  }),
  ports: z
    .array(
      z.object({
        name: z.string(),
        role: z.enum(["lan", "wan", "cpu"]),
        cpuName: z.string().optional(),
      })
    )
    .optional(),
  radios: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(["mac80211"]),
        path: z.string(),
        band: z.enum(["2g", "5g"]),
        htmode: z.enum(["HT20", "VHT80"]),
      })
    )
    .optional(),
});

export type DeviceSchema = z.infer<typeof deviceSchema>;
