// Devices' reads for the status views, from what each said (a status) or why
// it was not read ({ hostname, error }), as the collector hands them over.
import { problem } from "../../problem";
import { err, ok } from "../../result";
import type { DeviceStatus } from "../../status/device";
import type { Reachability } from "../../status/network";

export const reads = (...devices: (DeviceStatus | { hostname: string; error: string })[]): Reachability[] =>
  devices.map((d) => ("error" in d ? err(problem("unreachable", d.error, { hostname: d.hostname })) : ok(d)));
