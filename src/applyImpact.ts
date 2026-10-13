// What applying does that people notice, from what changes on a device: which
// services restart and roughly how long things pause, and how long the apply
// takes. Pure, and worded as estimates ("about", "may"): the timings are what
// the agent's steps take on the hardware this was tried on.
//
// Why each holds: the agent commits each changed config and runs
// `reload_config`, which reloads the services watching those configs (procd's
// triggers). netifd reloads changed interfaces. For Wi-Fi (25.12's netifd
// and hostapd.uc, read from source: no radio could be simulated in Docker), a
// radio is set up again only when its own config or one of its networks
// changed; hostapd then restarts the whole radio when a radio option changed
// (channel, width, country), and otherwise restarts only the networks that
// differ, leaving the rest connected. dnsmasq restarts on a dhcp change; fw4
// reloads its rules in place, keeping connections. Packages are installed
// before any of it, from the internet.
import { configLabel } from "./applyChanges";
import type { OpenWrtState } from "./engine/openWrtState";

/** How much an effect is noticed: devices drop and reconnect, a service pauses briefly, or nothing. */
export type Disruption = "reconnect" | "brief" | "none";

export const disruptionRank: Record<Disruption, number> = { reconnect: 2, brief: 1, none: 0 };

export type Effect = { text: string; disruption: Disruption };

/** What of a device's compiled state the effects depend on: small, and no value of a setting. */
export type ImpactFacts = {
  role?: string;
  /** Each radio's band ("2g", "5g", "6g"), by its section. */
  radios: Record<string, string>;
  /** The radios each Wi-Fi network is on, by its section. */
  networks: Record<string, string[]>;
  /** Managed files that run a command when written. */
  commandFiles: string[];
  /** Services restarted when a package they name changes (exact, or a prefix ending in `*`). */
  restarts: { service: string; packages: string[] }[];
};

export const impactFacts = (state: OpenWrtState, role?: string): ImpactFacts => {
  const wireless = state.config.wireless ?? {};
  return {
    ...(role ? { role } : {}),
    radios: Object.fromEntries((wireless["wifi-device"] ?? []).map((s) => [s[".name"], String(s.band ?? "")])),
    networks: Object.fromEntries(
      (wireless["wifi-iface"] ?? []).map((s) => [s[".name"], [s.device ?? []].flat().map(String)])
    ),
    commandFiles: state.files.filter((f) => f.runAfter || f.runAfterReload).map((f) => f.path),
    restarts: state.services.flatMap((s) => (s.restartOnPackages?.length ? [{ service: s.name, packages: s.restartOnPackages }] : [])),
  };
};

/** Some of a device's changes: `uci show` keys (a renamed section's too), packages, managed files. */
export type ChangedOn = {
  hostname: string;
  keys: string[];
  packages: { added: string[]; removed: string[] };
  files: string[];
  facts: ImpactFacts;
};

/** Configs whose reload nobody notices: rules reloaded in place, settings read on the next use. */
const quiet = new Set(["firewall", "luci", "rpcd", "ucitrack", "nlbwmon"]);

const bandWords: Record<string, string> = { "2g": "2.4 GHz", "5g": "5 GHz", "6g": "6 GHz", "60g": "60 GHz" };

const pluralised = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const listed = (words: string[]) =>
  words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** "5 GHz radio", "2.4 GHz and 5 GHz radios", or "radios" where a band is not known. */
const radiosWords = (radios: string[], facts: ImpactFacts) => {
  const bands = radios.map((r) => bandWords[facts.radios[r] ?? ""]);
  const known = [...new Set(bands.filter((b): b is string => b !== undefined))];
  return !radios.length || known.length < new Set(bands).size ? "radios" : `${listed(known)} radio${known.length === 1 ? "" : "s"}`;
};

/** Wi-Fi: a radio option restarts the radio; a network's restarts only that network (hostapd.uc). */
const wifiEffects = (hostname: string, keys: string[], facts: ImpactFacts): Effect[] => {
  const sections = [...new Set(keys.filter((k) => k.startsWith("wireless.")).map((k) => k.split(".")[1]))];
  if (!sections.length) return [];
  const radios = sections.filter((s) => s in facts.radios);
  const networks = sections.filter((s) => !(s in facts.radios));
  // A network's radio restarting anyway says it all for that network.
  const alone = networks.filter((s) => !(facts.networks[s] ?? []).some((r) => radios.includes(r)));
  return [
    ...(radios.length
      ? [{ text: `Wi-Fi restarts on ${hostname}'s ${radiosWords(radios, facts)}: every device on ${radios.length === 1 ? "it" : "them"} reconnects, in about 10 seconds.`, disruption: "reconnect" as const }]
      : []),
    ...(alone.length
      ? [
          {
            text: `The Wi-Fi networks that change on ${hostname} restart: devices on them reconnect, in about 10 seconds; the other networks stay up.`,
            disruption: "reconnect" as const,
          },
        ]
      : []),
  ];
};

/** What these changes do on one device, in words, each with how much it is noticed. */
export const effectsOf = ({ hostname, keys, packages, files, facts }: ChangedOn): Effect[] => {
  const configs = [...new Set(keys.map((k) => k.split(".")[0]))];
  const changedPackages = [...packages.added, ...packages.removed];
  const swapped = facts.restarts.filter((r) =>
    r.packages.some((pattern) => changedPackages.some((p) => (pattern.endsWith("*") ? p.startsWith(pattern.slice(0, -1)) : p === pattern)))
  );
  const others = configs.filter((c) => !quiet.has(c) && !["network", "wireless", "dhcp"].includes(c));
  return [
    ...(configs.includes("network")
      ? [
          {
            text:
              facts.role === "router"
                ? `The network reloads on ${hostname}: the internet and the local network may pause for a few seconds.`
                : `The network reloads on ${hostname}: devices connected through it may pause for a few seconds.`,
            disruption: "reconnect" as const,
          },
        ]
      : []),
    ...wifiEffects(hostname, keys, facts),
    ...(configs.includes("dhcp") ? [{ text: `DNS and DHCP restart on ${hostname}: lookups pause for about a second.`, disruption: "brief" as const }] : []),
    ...others.map((c) => ({ text: `${configLabel(c)} restarts on ${hostname}, briefly.`, disruption: "brief" as const })),
    ...(packages.added.length
      ? [{ text: `Installs ${pluralised(packages.added.length, "package")} on ${hostname}, downloaded first: about a minute.`, disruption: "none" as const }]
      : []),
    ...(packages.removed.length ? [{ text: `Removes ${pluralised(packages.removed.length, "package")} from ${hostname}.`, disruption: "none" as const }] : []),
    ...files.filter((f) => facts.commandFiles.includes(f)).map((f) => ({ text: `Writes ${f} on ${hostname} and runs its command.`, disruption: "brief" as const })),
    ...swapped.map((r) => ({ text: `Restarts ${r.service} on ${hostname}, as a package it uses changes.`, disruption: "brief" as const })),
  ];
};

/** The most an effect is noticed. */
export const worst = (effects: Effect[]): Disruption =>
  effects.reduce<Disruption>((w, e) => (disruptionRank[e.disruption] > disruptionRank[w] ? e.disruption : w), "none");

/**
 * Roughly how long one device's part takes, in seconds: prepare, stage,
 * commit and confirm over a reconnect; a reload that cuts the link takes its
 * own reconnect and settle; packages download first.
 */
export const secondsOf = ({ keys, packages }: Pick<ChangedOn, "keys" | "packages">) => {
  const has = (config: string) => keys.some((k) => k.startsWith(`${config}.`));
  return 30 + (has("network") || has("wireless") ? 20 : 0) + (packages.added.length ? 60 : 0);
};

/** The whole apply's length in seconds: each device in turn, then confirming them all. */
export const totalSeconds = (seconds: number[]) => seconds.reduce((sum, s) => sum + s, 0) + 15;

/** The whole apply's length, in words. */
export const durationWords = (seconds: number[]) => {
  const total = totalSeconds(seconds);
  return total < 90 ? "about a minute" : `about ${Math.round(total / 60)} minutes`;
};

/** The whole apply's length, in whole minutes (at least 1), for a "~N min" chip. */
export const minutesOf = (seconds: number[]) => Math.max(1, Math.round(totalSeconds(seconds) / 60));
