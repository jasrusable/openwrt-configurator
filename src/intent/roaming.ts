// Wi-Fi › Roaming: what each steering level makes usteer do. Off stops it
// and turns neighbour lists off everywhere; from Advise on, each SSID's
// roaming assistance chooses whether it takes part. The compiler
// writes these values (features/wifi.ts) and the explainers quote them
// (fields.ts), from this one table, so what the UI says is what the devices
// do. Signals are dBm (usteer reads a negative value as a signal level, a
// positive one as SNR); 0 is off.
import { where } from "./places";
import type { Intent } from "./schema";

export const steeringLevels = ["off", "advise", "nudge", "push"] as const;
export type SteeringLevel = (typeof steeringLevels)[number];

export const steeringLabels: Record<SteeringLevel, string> = {
  off: "Off",
  advise: "Advise",
  nudge: "Nudge",
  push: "Push",
};

export const steeringValues: Record<
  SteeringLevel,
  {
    /** 1: a request the device may ignore; 3: one that says it will be disconnected, then is. */
    aggressiveness: number;
    /** Below this, ask the device what it sees (an 802.11k beacon report). */
    scanBelow: number;
    /** Below this, ask it to move to a better access point or band. */
    moveBelow: number;
    /** Below this for `floorFor`, disconnect it, so it reconnects somewhere better. */
    floor: number;
  }
> = {
  off: { aggressiveness: 1, scanBelow: 0, moveBelow: 0, floor: 0 },
  advise: { aggressiveness: 1, scanBelow: 0, moveBelow: 0, floor: 0 },
  nudge: { aggressiveness: 1, scanBelow: -70, moveBelow: -75, floor: 0 },
  push: { aggressiveness: 3, scanBelow: -70, moveBelow: -75, floor: -82 },
};

/** Whether an SSID takes part: roaming is not Off, and its roaming assistance is on. */
export const takesPart = (intent: Intent, ssid: Intent["wifi"][number]) =>
  (intent.roaming?.steering ?? "advise") !== "off" && ssid.roaming_assistance !== false;

/** The SSIDs usteer manages: those taking part that are broadcast. */
export const steeredSsids = (intent: Intent) =>
  intent.wifi.filter((ssid) => ssid.enabled && takesPart(intent, ssid));

/** How much stronger (dB) another access point or band must be to move to. */
export const betterBy = 8;
/** How long a move request stays open, and (Push) until the device is disconnected. */
export const moveWithinMs = 10_000;
/** How long a device stays below the floor before it is disconnected (Push). */
export const floorForMs = 5_000;
/** Prefer 5 GHz: a 2.4 GHz device this strong for this long is asked to move up. */
export const bandSteering = { strongerThan: -60, forMs: 30_000 };

/** Each level in a few plain words, for descriptions. */
export const steeringSummary: Record<SteeringLevel, string> = {
  off: "no neighbour lists, and no device is moved",
  advise: "devices decide when to move, helped by neighbour lists",
  nudge: "a device whose signal fades is asked to move",
  push: "a device whose signal fades is asked to move, and disconnected if it does not",
};

const seconds = (ms: number) => `${ms / 1000} seconds`;

/** What a level does, in a sentence, with the values the compiler writes. */
export const describeSteering = (level: SteeringLevel) => {
  const { moveBelow, floor } = steeringValues[level];
  switch (level) {
    case "off":
      return "Access points give no neighbour lists (802.11k/v off on every SSID) and usteer is stopped: devices find their own way.";
    case "advise":
      return "Access points share neighbour lists (802.11k/v), so devices find a better one sooner; devices decide when to move.";
    case "nudge":
      return `Once a device's signal drops below ${moveBelow} dBm and another access point or band is ${betterBy} dB stronger, it is asked to move (802.11v), and may ignore it.`;
    case "push":
      return `Once a device's signal drops below ${moveBelow} dBm and another access point or band is ${betterBy} dB stronger, it is asked to move (802.11v), told it will be disconnected, and after ${seconds(moveWithinMs)} it is; a device below ${floor} dBm for ${seconds(floorForMs)} is disconnected too, so it can reconnect somewhere better.`;
  }
};

/** What Prefer 5 GHz does at a level. */
export const describePrefer5g = (level: SteeringLevel) =>
  `A device that supports 802.11v and holds ${bandSteering.strongerThan} dBm or better on 2.4 GHz for ${seconds(bandSteering.forMs)} is asked to move to a faster band on the same access point${
    steeringValues[level].aggressiveness >= 3
      ? `, and disconnected after ${seconds(moveWithinMs)} if it does not (Steering is ${steeringLabels[level]})`
      : `; it may ignore it (with Steering on ${steeringLabels.push}, it would be disconnected)`
  }.`;

/** Every level, for Steering's explainer. */
export const describeSteeringLevels = () =>
  steeringLevels.map((level) => `${steeringLabels[level]}: ${describeSteering(level)}`).join(" ") +
  ` Only on SSIDs with roaming assistance (${where("ssids")}).`;
