// A device that speaks the tool's protocol well enough to drive the provision
// phases without SSH or Docker, recording what happens to it. Not a test file
// (ava skips helpers/).
import { stateOf } from "./fixtures";
import { AgentRecord, decodeRecords } from "../../agent/records";
import { DeviceRunOptions } from "../../apply/run";
import { commandTimeoutMs, ExecResult, Session } from "../../platform";
import { confirmTiming } from "../../apply/reconnect";
import { UciConfigs, UciSection } from "../../engine/uci";

export type FakeDevice = {
  hostname: string;
  ipAddress: string;
  /** What the device saw, in order: "arm", "configure", "commit", "disarm", ... */
  events: string[];
  /** Whether a committed change is in place (and not rolled back). */
  changed: boolean;
  /** The committed UCI config. */
  committed: () => UciConfigs;
  reachable: boolean;
  /** Every session open now dies (a later device's change cut them); new ones work. */
  dropSessions: () => void;
  options: (clock: Clock) => DeviceRunOptions;
};

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

/** A clock where sleeping advances time instantly. */
export const virtualClock = (): Clock => {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
};

const clone = (configs: UciConfigs): UciConfigs =>
  JSON.parse(JSON.stringify(configs));

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const unquote = (value: string) =>
  value.startsWith("'") ? value.slice(1, -1).replace(/'\\''/g, "'") : value;

/** `uci export` of the model, as the uciConfigs probe prints it. */
export const formatUciExport = (configs: UciConfigs) =>
  Object.entries(configs)
    .map(([configKey, sections]) =>
      [
        `package ${configKey}`,
        ...sections.map((section) =>
          [
            "",
            `config ${section.type}` +
              (section.name !== undefined ? ` ${quote(section.name)}` : ""),
            ...Object.entries(section.options).flatMap(([key, value]) =>
              Array.isArray(value)
                ? value.map((item) => `\tlist ${key} ${quote(item)}`)
                : [`\toption ${key} ${quote(value)}`]
            ),
          ].join("\n")
        ),
        "",
      ].join("\n")
    )
    .join("\n");

/** One uci operation (`set a.b.c='v'`, `add_list ...`, `delete a.b`), as uci would apply it. */
const applyOperation = (configs: UciConfigs, line: string) => {
  const [, op, path, value] = /^(\w+) ([^=]+)(?:=([\s\S]*))?$/.exec(line) || [];
  const [configKey, ref, option] = path.split(".");
  const sections = (configs[configKey] ??= []);
  const anon = /^@(\w+)\[0\]$/.exec(ref);
  const index = anon ? sections.findIndex((s) => s.type === anon[1]) : sections.findIndex((s) => s.name === ref);
  if (op === "delete") {
    if (index < 0) throw new Error(`uci: Entry not found (${path})`);
    sections.splice(index, 1);
  } else if (op === "set" && option === undefined) {
    if (index < 0) sections.push({ type: value, name: ref, options: {} });
  } else {
    const section: UciSection = sections[index];
    const item = unquote(value);
    if (op === "add_list") {
      const list = section.options[option];
      section.options[option] = [...(Array.isArray(list) ? list : []), item];
    } else if (item === "") delete section.options[option];
    else section.options[option] = item;
  }
};

/** Apply stage's uci records (its batches, and operations spanning lines), as uci would. */
export const applyRecords = (configs: UciConfigs, records: AgentRecord[]) => {
  for (const record of records) {
    if (record.kind === "batch") record.operations.forEach((line) => applyOperation(configs, line));
    if (record.kind === "set" || record.kind === "add_list") applyOperation(configs, `${record.kind} ${record.key}=${quote(record.value)}`);
  }
};

export const fakeDevice = ({
  hostname,
  ipAddress = `10.0.0.${hostname.length}`,
  failOn,
  lockedOutAfterCommit = false,
  log = [],
  initialConfig = {
    system: [{ type: "system", options: { hostname: "OpenWrt" } }],
    network: [{ type: "interface", name: "stale", options: {} }],
  },
  afterStage,
  afterPackages,
  services,
  newPackages,
  slowReconnectMs,
  commitIncomplete = false,
  onEvent,
  removes,
  firesBeforeDisarm = false,
  stagesShort = false,
  arming = "arms",
  dropsDuringConfigure = false,
  stalls,
}: {
  /**
   * This agent verb never answers (the client stalls, the link up): the call
   * runs out its time limit on the clock, the device untouched by it.
   */
  stalls?: string;
  /** Staging the packages it removes keeps one fewer than asked (no room in /tmp). */
  stagesShort?: boolean;
  /**
   * How its arm goes: "refused" (the agent says why, no watchdog) or
   * "link-drops" (the watchdog starts, then the link drops before the answer).
   */
  arming?: "arms" | "refused" | "link-drops";
  /** The link drops while the configure script runs: its result has no exit status. */
  dropsDuringConfigure?: boolean;
  /** Told each event as it happens, to make something else happen then. */
  onEvent?: (event: string) => void;
  /** Packages the config removes (the device has them): staged for a rollback first. */
  removes?: string[];
  /** The watchdog fires just before the disarm lands. */
  firesBeforeDisarm?: boolean;
  /** The link drops partway through the commits: the marker is never written. */
  commitIncomplete?: boolean;
  /** After its commit, each new connection takes this long (a slow device or link). */
  slowReconnectMs?: number;
  hostname: string;
  /** Packages the config installs that the device does not have yet. */
  newPackages?: string[];
  /** Services the config declares (started over the first reconnect). */
  services?: { name: string; running: boolean }[];
  ipAddress?: string;
  failOn?: "configure" | "commit";
  /** The committed config cuts SSH off until the device rolls back. */
  lockedOutAfterCommit?: boolean;
  /** Shared by several devices: one chronological record across all of them. */
  log?: string[];
  /** The committed UCI config before the run. */
  initialConfig?: UciConfigs;
  /** Something else changes the staged config just after the batch. */
  afterStage?: (staged: UciConfigs) => void;
  /** A package's postinst adds config, and commits it, in the package step. */
  afterPackages?: (committed: UciConfigs) => void;
}): FakeDevice => {
  let clock: Clock | undefined;
  const record = (event: string) => {
    device.events.push(event);
    log.push(`${hostname}:${event}`);
    onEvent?.(event);
  };
  let generation = 0;
  let fireAt: number | undefined;
  let committed = clone(initialConfig);
  let staged = clone(initialConfig);
  // The commit's marker, written by finalise once its commits are done.
  let commitMarked = false;
  // The watchdog: once its window passes undisarmed, it restores the snapshot.
  const watchdogTick = () => {
    if (fireAt !== undefined && clock && clock.now() >= fireAt) {
      fireAt = undefined;
      record("watchdog-fired");
      committed = clone(initialConfig);
      staged = clone(initialConfig);
      device.changed = false;
      device.reachable = true;
    }
  };

  const device: FakeDevice = {
    hostname,
    ipAddress,
    events: [],
    changed: false,
    committed: () => committed,
    reachable: true,
    dropSessions: () => {
      generation += 1;
    },
    options: (c) =>
      (clock = c) && {
        deviceModelId: "fake,device",
        ipAddress,
        hostname,
        ssh: session(),
        connect: async () => {
          if (slowReconnectMs && device.events.includes("commit")) await c.sleep(slowReconnectMs);
          watchdogTick();
          if (!device.reachable) throw new Error(`${hostname} unreachable`);
          return session();
        },
        state: stateOf({
          config: { system: { system: [{ ".name": "s", hostname }] } },
          services: services ?? [],
          packages: { add: newPackages ?? [], remove: removes ?? [] },
        }),
        rollbackMode: "reload-then-reboot",
        recoverSeconds: 30,
        sleep: c.sleep,
        now: c.now,
        timing: { ...confirmTiming(), minimumConfirmWindowMs: 1000 },
      },
  };

  const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
  /** A step verb that stopped: at its first step, with the device's words. */
  const stopped = (step: string): ExecResult => ({ stdout: `ONC_STEP ${step}\n`, stderr: "boom", code: 1 });

  /** The agent's step verbs, by the event each was: what the device does with its records. */
  const stepVerb = (kind: string, records: AgentRecord[]): ExecResult => {
    record(kind);
    if (failOn === kind) return stopped(kind === "commit" ? "commit system" : "uci batch");
    if (kind === "configure" && dropsDuringConfigure) {
      device.dropSessions();
      return { stdout: "ONC_STEP uci batch\n", stderr: "", code: null };
    }
    if (kind === "configure") {
      applyRecords(staged, records);
      afterStage?.(staged);
    }
    if (kind === "commit") {
      // Written by finalise once every commit is done: never, when the link drops partway.
      commitMarked = !commitIncomplete;
      committed = clone(staged);
      device.changed = true;
      if (lockedOutAfterCommit) device.reachable = false;
    }
    if (kind === "packages") afterPackages?.(committed);
    if (kind === "revert" || kind === "packages") staged = clone(committed);
    if (kind === "revert") device.changed = false;
    return ok("ONC_OK\n");
  };

  const agentVerb = (verb: string, command: string, stdin = ""): ExecResult => {
    switch (verb) {
      case "begin":
        record("prepare");
        return ok("ONC_BEGUN\n");
      case "revert":
        return stepVerb("revert", []);
      case "prepare":
        return stepVerb("packages", decodeRecords(stdin));
      case "stage":
        return stepVerb("configure", decodeRecords(stdin));
      case "finalise":
        return stepVerb("commit", decodeRecords(stdin));
      case "services":
        return stepVerb("services", decodeRecords(stdin));
      case "hooks":
        return stepVerb("hooks", decodeRecords(stdin));
      case "stage-packages":
        record("stage");
        return ok(`ONC_STAGED ${(removes ?? []).length - (stagesShort ? 1 : 0)}\n`);
      case "arm":
        if (arming === "refused") {
          record("arm-refused");
          return { stdout: "", stderr: "onc-agent: could not snapshot the device (no room in /tmp?)", code: 1 };
        }
        record("arm");
        fireAt = clock!.now() + Number(/'--timeout' '(\d+)'/.exec(command)?.[1]) * 1000;
        if (arming === "link-drops") {
          device.dropSessions();
          return { stdout: "", stderr: "", code: null };
        }
        return ok("ONC_ARMED\n");
      case "disarm":
        if (firesBeforeDisarm && fireAt !== undefined) {
          fireAt = clock!.now();
          watchdogTick();
        }
        // Too late: the watchdog already restored the old config.
        if (device.events.includes("watchdog-fired")) return ok("ONC_FIRED\n");
        record("disarm");
        fireAt = undefined;
        return ok("ONC_DISARMED\n");
      case "rollback-now":
        // The watchdog restores the snapshot and access returns.
        record("rollback-now");
        committed = clone(initialConfig);
        staged = clone(initialConfig);
        fireAt = undefined;
        device.changed = false;
        device.reachable = true;
        return ok("ONC_WOKEN\n");
      case "commit-finished":
        return commitMarked ? ok("ONC_COMMITTED\n") : ok();
      case "recovered":
        // Only once the watchdog has restored the old config.
        if (!device.events.some((e) => e === "watchdog-fired" || e === "rollback-now")) return ok();
        record("recovered");
        return ok("ONC_RECOVERED\n");
      case "done":
        return ok("ONC_DONE\n");
      case "drop":
        record("drop");
        fireAt = undefined;
        return ok("ONC_DROPPED\n");
      default:
        return { stdout: "", stderr: `unknown verb ${verb}`, code: 2 };
    }
  };

  // runProbes sends several probes as one command; answer each in turn.
  const probeBatch = async (
    command: string,
    single: (c: string) => Promise<ExecResult>
  ) => {
    const parts = [
      ...command.matchAll(/\( ([\s\S]*?)\n\) 2>\/dev\/null; printf/g),
    ];
    let stdout = "";
    for (const [, probe] of parts) {
      const result = await single(probe);
      stdout += `${result.stdout}\n__ONC_PROBE__${result.code ?? 1}\n`;
    }
    return ok(stdout);
  };

  const session = (born = generation): Session => ({
    execCommand: async function execCommand(
      command,
      options
    ): Promise<ExecResult> {
      if (born !== generation) throw new Error("Not connected");
      if (command.includes("__ONC_PROBE__") && device.reachable) {
        return probeBatch(command, (c) => execCommand(c, undefined));
      }
      watchdogTick();
      if (!device.reachable) return { stdout: "", stderr: "", code: null };
      // The agent (src/agent): written with its first verb, then called by verb.
      const verb = /sh \/tmp\/onc-agent-\w+\.sh (\S+)/.exec(command)?.[1];
      if (verb && verb === stalls) {
        record(`stalled ${verb}`);
        await clock!.sleep(options?.timeoutMs ?? commandTimeoutMs);
        return { stdout: "", stderr: "", code: null, timedOut: true };
      }
      if (verb) return agentVerb(verb, command, options?.stdin);
      if (command.startsWith("cat /etc/board.json"))
        return ok(
          JSON.stringify({
            model: { id: "fake,device" },
            network: { lan: { protocol: "static" } },
          })
        );
      if (command === "apk info") return ok("dnsmasq\n");
      if (command.startsWith("apk del --simulate")) return ok((removes ?? []).map((p, i) => `(${i + 1}/${removes!.length}) Purging ${p} (1.0)`).join("\n"));
      if (command.includes("uci export")) return ok(formatUciExport(staged));
      if (command === "uci changes" || command === "true") return ok();
      if (command.includes("ubus call service list")) {
        record("settle");
        return ok();
      }
      return { stdout: "", stderr: "", code: 1 };
    },
    dispose: () => {},
  });

  return device;
};
