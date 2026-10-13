// A device that speaks the tool's protocol well enough to drive the provision
// phases without SSH or Docker, recording what happens to it. Not a test file
// (ava skips helpers/).
import { DeviceRunOptions } from "../../devicePhases";
import { ExecResult, Session } from "../../platform";
import { confirmTiming } from "../../confirm";
import { UciConfigs, UciSection } from "../../uci";

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

const markersIn = (script: string) =>
  (script.match(/__ONC_OK__\d+/g) || []).length;

const kindOf = (script: string) =>
  script.includes("setsid")
    ? "arm"
    : script.includes("uci batch")
    ? "configure"
    : script.includes("uci commit")
    ? "commit"
    : script.includes("/tmp/onc-rollback")
    ? "prepare"
    : script.includes("reload_config")
    ? "packages"
    : script.includes('/etc/init.d/$s')
    ? "services"
    : "revert";

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

/** Apply the operations of the script's `uci batch`es, as uci would. */
const applyBatches = (configs: UciConfigs, script: string) => {
  const batches = [...script.matchAll(/<<'(ONC_UCI_*)'\n([\s\S]*?)\n\1\n/g)];
  for (const [, , body] of batches) {
    for (const line of body.split("\n")) {
      const [, op, path, value] =
        /^(\w+) ([^=]+)(?:=(.*))?$/.exec(line) || [];
      const [configKey, ref, option] = path.split(".");
      const sections = (configs[configKey] ??= []);
      const anon = /^@(\w+)\[0\]$/.exec(ref);
      const index = anon
        ? sections.findIndex((s) => s.type === anon[1])
        : sections.findIndex((s) => s.name === ref);
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
    }
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
}: {
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
  };
  let fireAt: number | undefined;
  let committed = clone(initialConfig);
  let staged = clone(initialConfig);
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
        state: {
          config: { system: { system: [{ ".name": "s", hostname }] } } as any,
          ...(services ? { services } : {}),
          ...(newPackages ? { packagesToInstall: newPackages.map((packageName) => ({ packageName })) } : {}),
        },
        rollbackMode: "reload-then-reboot",
        recoverSeconds: 30,
        sleep: c.sleep,
        now: c.now,
        timing: { ...confirmTiming(), minimumConfirmWindowMs: 1000 },
      },
  };

  const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
  let script = "";

  const runScript = (): ExecResult => {
    const kind = kindOf(script);
    record(kind);
    if (kind === "arm") {
      const seconds = Number(/sleep (\d+) &/.exec(script)?.[1]);
      fireAt = clock!.now() + seconds * 1000;
    }
    const count = markersIn(script);
    if (failOn === kind) {
      return { stdout: "__ONC_OK__0\n", stderr: "boom", code: 1 };
    }
    if (kind === "configure") {
      applyBatches(staged, script);
      afterStage?.(staged);
    }
    if (kind === "commit") {
      committed = clone(staged);
      device.changed = true;
      if (lockedOutAfterCommit) device.reachable = false;
    }
    if (kind === "packages") afterPackages?.(committed);
    if (kind === "revert" || kind === "packages") staged = clone(committed);
    if (kind === "revert") device.changed = false;
    return ok(
      Array.from({ length: count }, (_, i) => `\n__ONC_OK__${i}`).join("") +
        "\n"
    );
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

  const session = (): Session => ({
    execCommand: async function execCommand(
      command,
      options
    ): Promise<ExecResult> {
      if (command.includes("__ONC_PROBE__") && device.reachable) {
        return probeBatch(command, (c) => execCommand(c, undefined));
      }
      watchdogTick();
      if (!device.reachable) return { stdout: "", stderr: "", code: null };
      if (command.startsWith("umask 077 && cat >")) {
        script = options?.stdin ?? "";
        return ok();
      }
      if (command.startsWith("sh /tmp/.onc-provision-")) return runScript();
      if (command.startsWith("cat /etc/board.json"))
        return ok(
          JSON.stringify({
            model: { id: "fake,device" },
            network: { lan: { protocol: "static" } },
          })
        );
      if (command === "apk info") return ok("dnsmasq\n");
      if (command.includes("uci export")) return ok(formatUciExport(staged));
      if (command === "uci changes" || command === "true") return ok();
      if (command.includes("ubus call service list")) {
        record("settle");
        return ok();
      }
      if (
        command.includes("onc-confirmed-") &&
        command.includes("ONC_DISARMED")
      ) {
        // Too late: the watchdog already restored the old config.
        if (device.events.includes("watchdog-fired")) return ok("ONC_FIRED\n");
        record("disarm");
        fireAt = undefined;
        return ok("ONC_DISARMED\n");
      }
      // Exactly rollBackNowCommand; the disarm cleanup also names the .sleep file.
      if (/^s=\$\(cat \/tmp\/onc-watchdog-\w+\.sleep/.test(command)) {
        // rollBackNow: the watchdog restores the snapshot and access returns.
        record("rollback-now");
        committed = clone(initialConfig);
        staged = clone(initialConfig);
        fireAt = undefined;
        device.changed = false;
        device.reachable = true;
        return ok();
      }
      // The commit's marker (rollback.ts committedFlag): there once a commit ran whole.
      if (command.startsWith("[ -f /tmp/onc-committed-")) {
        return device.events.includes("commit") && !commitIncomplete ? ok("ONC_COMMITTED\n") : { stdout: "", stderr: "", code: 1 };
      }
      if (command.startsWith("touch /tmp/onc-recovered-")) {
        record("recovered");
        return ok();
      }
      return { stdout: "", stderr: "", code: 1 };
    },
    dispose: () => {},
  });

  return device;
};
