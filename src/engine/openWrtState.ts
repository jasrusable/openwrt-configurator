// What the engine leaves for one device: its UCI config, concrete (every
// condition decided, every placeholder fitted to the device), and the rest
// of what an apply does there. Checked by the device itself: the wipe, then
// reading back and verifying every section (src/uci.ts).

import { KeepEntry } from "../plan/types";

export type UciScalar = string | number | boolean;

/** A section as uci batch takes it: its name, and its options (lists as arrays). */
export type OpenWrtSection = { ".name": string } & { [option: string]: UciScalar | UciScalar[] };

/** config -> section type -> sections, in the order they are written. */
export type OpenWrtConfig = Record<string, Record<string, OpenWrtSection[]>>;

export type OpenWrtState = {
  config: OpenWrtConfig;
  /** apk packages to install, and to remove. */
  packages: { add: string[]; remove: string[] };
  /** What the wipe leaves alone; everything else on the device is wiped. */
  keep: KeepEntry[];
  /** Configs declared new on purpose: not on the device, not shipped by OpenWrt. */
  newConfigs?: string[];
  /** Services to keep enabled and started; `running` ones are checked. */
  services: Service[];
  files: StateFile[];
};

export type Service = {
  name: string;
  running: boolean;
  enabled?: boolean;
  restartAfterRollback?: boolean;
  /** Restarted when the run changes one of these packages (exact, or a prefix ending in `*`). */
  restartOnPackages?: string[];
};

export type StateFile = {
  path: string;
  content: string;
  mode?: string;
  /** Runs as soon as the file is written, before `uci commit`. */
  runAfter?: string;
  /** Runs after `uci commit` and `reload_config`, so the config is live. */
  runAfterReload?: string;
};
