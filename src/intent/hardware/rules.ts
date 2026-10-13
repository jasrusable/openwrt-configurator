// What a device may be, given the rest: one router, cabled; its channels
// ones the country allows.
import type { Choice, ChoiceAt } from "../feature";
import { where } from "../places";
import { channelsOf, illegalChannelReason } from "../radios";
import { regdb } from "../wifi/regdb";
import type { Intent } from "../schema";

/** A channel pinned on a device: one the country allows (hostapd would not start on another). */
const legalPins: Choice[] = [
  {
    path: "hardware.*.radios.2g.channel",
    values: channelsOf["2g"],
    unavailable: (intent, _, channel) => illegalChannelReason(intent.system.country, "2g", channel),
  } satisfies ChoiceAt<"hardware.*.radios.2g.channel">,
  {
    path: "hardware.*.radios.5g.channel",
    values: channelsOf["5g"],
    unavailable: (intent, _, channel) => illegalChannelReason(intent.system.country, "5g", channel),
  } satisfies ChoiceAt<"hardware.*.radios.5g.channel">,
];

/** The first channel set (pinned, or the mesh's) that a country would not allow, in words. */
const strandedBy = (intent: Intent, country: string) => {
  const pins = intent.hardware.flatMap((device) =>
    (["2g", "5g"] as const).flatMap((band) => {
      const channel = device.radios?.[band]?.channel;
      return illegalChannelReason(country, band, channel) ? [`channel ${channel} pinned on ${device.name}`] : [];
    })
  );
  const mesh =
    intent.wifi.mesh.enabled && illegalChannelReason(country, intent.wifi.mesh.band, intent.wifi.mesh.channel)
      ? [`the mesh's channel ${intent.wifi.mesh.channel}`]
      : [];
  return [...pins, ...mesh][0];
};

export const hardwareRules: Choice[] = [
  ...legalPins,
  {
    // A country that forbids a channel already set: that channel first.
    path: "system.country",
    values: Object.keys(regdb),
    unavailable: (intent, _, country) => {
      const stranded = strandedBy(intent, country);
      return stranded && `Not allowed there: ${stranded}. Change it first (${where("hardware")}).`;
    },
    // The channel's own rule reports it.
    refuses: false,
  },
  {
    // Making another device the router hands the role over.
    path: "hardware.*.role",
    values: ["router"],
    swap: (intent, [i]) => {
      const current = intent.hardware.findIndex((d, j) => d.role === "router" && j !== Number(i));
      if (current < 0) return undefined;
      return {
        note: `${intent.hardware[current].name || "The current router"} becomes an access point.`,
        apply: (next) => ({
          ...next,
          hardware: next.hardware.map((d, j) => {
            // The router is cabled: a mesh uplink it had as an access point goes.
            return j === Number(i)
              ? { ...d, role: "router", uplink: "cable" }
              : j === current
                ? { ...d, role: "access-point" }
                : d;
          }),
        }),
      };
    },
  },
  {
    path: "hardware.*.role",
    values: ["access-point"],
    unavailable: (intent, [i]) =>
      intent.hardware[Number(i)]?.role === "router" &&
      (intent.hardware.length > 1
        ? "A network has one router: choose Router on the device that should take over, and this one becomes an access point."
        : "A network needs a router."),
    // The schema's "exactly one router" says it for a hand-edited file.
    refuses: false,
  },
  {
    path: "hardware.*.uplink",
    values: ["mesh"],
    unavailable: (intent, [i]) =>
      intent.hardware[Number(i)]?.role === "router" && "The router is where the network starts: it is cabled.",
  },
];
