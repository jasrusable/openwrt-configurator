// What a device may be, given the rest: one router, cabled.
import type { Choice } from "../feature";

export const hardwareRules: Choice[] = [
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
