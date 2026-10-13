import test, { ExecutionContext } from "ava";
// Serial: these silence console globally while a run prints its progress.
import { fakeDevice, virtualClock } from "../helpers/fakeDevice";
import { ApplyEvent, parseEvents, progressOf } from "../../applyEvents";
import { RunResult } from "../../apply/outcome";
import { provisioningOrder, provisionNetwork } from "../../apply/provisionNetwork";

const quietly = async <T>(fn: () => Promise<T>) => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
};

/** The run's failure: it must not have applied. */
const failure = async (t: ExecutionContext, pending: Promise<RunResult>) => {
  const result = await pending;
  t.false(result.ok, "the run applied");
  return result.ok ? undefined : result.error;
};

/** A run that must apply. */
const applies = async (t: ExecutionContext, pending: Promise<RunResult>) => {
  const result = await pending;
  t.true(result.ok, result.ok ? "" : result.error.message);
};

const run = (devices: ReturnType<typeof fakeDevice>[]) => {
  const clock = virtualClock();
  return quietly(() =>
    provisionNetwork({
      devices: devices.map((d) => d.options(clock)),
      confirm: true,
      confirmTimeoutSeconds: 60,
    })
  );
};

test.serial("one device: armed before configuring, disarmed only after confirming", async (t) => {
  const device = fakeDevice({ hostname: "ap" });
  await applies(t, run([device]));
  t.deepEqual(
    device.events.filter((e) => e !== "revert"),
    ["prepare", "arm", "packages", "configure", "commit", "settle", "disarm"]
  );
  t.true(device.changed);
  // Wiped, then exactly the declared config: the stale interface and the
  // anonymous system section are gone.
  t.deepEqual(device.committed(), {
    system: [{ type: "system", name: "s", options: { hostname: "ap" } }],
    network: [],
  });
});

test.serial("config a package adds during the run is wiped too", async (t) => {
  const device = fakeDevice({
    hostname: "ap",
    afterPackages: (committed) => {
      committed.sqm = [{ type: "queue", name: "eth1", options: {} }];
      committed.system.push({ type: "timeserver", name: "ntp", options: {} });
    },
  });
  await applies(t, run([device]));
  t.deepEqual(device.committed().sqm, []);
  t.deepEqual(
    device.committed().system.map((s) => s.name),
    ["s"]
  );
});

test.serial("a staged config that does not verify is never committed", async (t) => {
  const device = fakeDevice({
    hostname: "ap",
    afterStage: (staged) => {
      staged.system[0].options.hostname = "someone-else";
    },
  });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /does not match the config file/);
  t.false(device.events.includes("commit"));
  t.false(device.changed);
  t.is(device.committed().system[0].options.hostname, "OpenWrt");
});

test.serial("a failed configure after new packages is rolled back, never disarmed: only the watchdog undoes packages", async (t) => {
  const device = fakeDevice({
    hostname: "ap",
    newPackages: ["nlbwmon"],
    afterStage: (staged) => {
      staged.system[0].options.hostname = "someone-else";
    },
  });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /No device keeps a change/);
  t.false(device.events.includes("commit"));
  t.true(device.events.includes("rollback-now"));
  t.false(device.events.includes("disarm"));
});

test.serial("confirming runs to the earliest watchdog's deadline: a slow device never outlasts another's window", async (t) => {
  const first = fakeDevice({ hostname: "router" });
  const slow = fakeDevice({ hostname: "far-ap", slowReconnectMs: 70_000 });
  const error = await failure(t, run([first, slow]));
  t.regex(error!.message, /no device keeps a change|rolled itself back/i);
  // Neither device keeps the change, and none was reported confirmed while rolled back.
  t.false(first.changed);
  t.false(slow.changed);
  t.false(first.events.includes("disarm") && first.events.includes("watchdog-fired"));
});

test.serial("a commit the link dropped partway through is rolled back now, never confirmed", async (t) => {
  const device = fakeDevice({ hostname: "ap", commitIncomplete: true });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /did not complete/);
  t.true(device.events.includes("rollback-now"));
  t.false(device.events.includes("disarm"));
});

test.serial("services start before the settle and the confirming reconnect: inside the rollback", async (t) => {
  const device = fakeDevice({ hostname: "ap", services: [{ name: "firewall", running: false }] });
  await applies(t, run([device]));
  const events = device.events.filter((e) => e !== "revert");
  t.true(events.indexOf("services") > events.indexOf("commit"));
  t.true(events.indexOf("services") < events.indexOf("settle"));
  t.true(events.indexOf("settle") < events.indexOf("disarm"));
});

test.serial("every device is armed before any is changed, and disarmed only once all confirm", async (t) => {
  const log: string[] = [];
  const devices = ["a", "b", "c"].map((hostname) =>
    fakeDevice({ hostname, log })
  );
  await applies(t, run(devices));
  const lastArm = Math.max(
    ...devices.map((d) => log.indexOf(`${d.hostname}:arm`))
  );
  const firstConfigure = log.findIndex((e) => e.endsWith(":configure"));
  const lastSettle = Math.max(
    ...devices.map((d) => log.lastIndexOf(`${d.hostname}:settle`))
  );
  const firstDisarm = log.findIndex((e) => e.endsWith(":disarm"));
  t.true(lastArm < firstConfigure, "all armed before the first change");
  t.true(lastSettle < firstDisarm, "all confirmed before the first disarm");
  t.true(devices.every((d) => d.changed && d.events.includes("disarm")));
});

test.serial("a device failing to configure rolls back those already committed", async (t) => {
  const [a, b, c] = [
    fakeDevice({ hostname: "a" }),
    fakeDevice({ hostname: "b", failOn: "configure" }),
    fakeDevice({ hostname: "c" }),
  ];
  const error = await failure(t, run([a, b, c]));
  t.regex(error!.message, /No device keeps a change from this run/);
  t.true(
    a.events.includes("rollback-now"),
    "a was committed, so it is rolled back now"
  );
  t.false(a.changed);
  t.false(b.events.includes("commit"), "b never committed");
  t.false(c.events.includes("configure"), "c was never touched...");
  t.true(c.events.includes("disarm"), "...and its watchdog is stood down");
});

test.serial("a device that cuts itself off after commit takes the whole change back", async (t) => {
  const [a, b] = [
    fakeDevice({ hostname: "a" }),
    fakeDevice({ hostname: "b", lockedOutAfterCommit: true }),
  ];
  const error = await failure(t, run([a, b]));
  t.regex(error!.message, /cut off access to b/);
  t.true(a.events.includes("rollback-now"));
  t.false(a.events.includes("disarm"), "a was never disarmed");
  t.true(
    b.events.includes("watchdog-fired"),
    "b rolled itself back at its deadline"
  );
  t.true(
    b.events.includes("recovered"),
    "and was told it recovered, so it need not reboot"
  );
  t.false(a.changed || b.changed);
});

test.serial("the gateway and the device running the tool go last", (t) => {
  const device = (ipAddress: string, local = false) => ({
    ipAddress,
    hostname: `d${ipAddress.split(".")[3]}`,
    ssh: { local },
  });
  const ordered = provisioningOrder(
    [
      device("10.0.0.1"),
      device("10.0.0.5", true),
      device("10.0.0.2"),
      device("10.0.0.3"),
    ],
    "10.0.0.1"
  );
  t.deepEqual(
    ordered.map((d) => d.ipAddress),
    ["10.0.0.2", "10.0.0.3", "10.0.0.1", "10.0.0.5"]
  );
  const repeater = { ...device("10.0.0.9"), order: -1 };
  t.deepEqual(
    provisioningOrder([device("10.0.0.2"), repeater, device("10.0.0.3")], "10.0.0.1").map((d) => d.ipAddress),
    ["10.0.0.9", "10.0.0.2", "10.0.0.3"],
    "a mesh repeater before what it hangs off"
  );
  t.deepEqual(
    provisioningOrder([device("10.0.0.1"), device("10.0.0.2"), device("10.0.0.3"), device("10.0.0.4")], "10.0.0.1", ["d2"]).map(
      (d) => d.ipAddress
    ),
    ["10.0.0.3", "10.0.0.4", "10.0.0.2", "10.0.0.1"],
    "the access point this machine is on by Wi-Fi: after the rest, before the gateway"
  );
});

test.serial("a run says where each device is, and how it ended, as data", async (t) => {
  const reported = async (devices: ReturnType<typeof fakeDevice>[]) => {
    const clock = virtualClock();
    const events: ApplyEvent[] = [];
    const report = (e: ApplyEvent) => events.push(e);
    await quietly(() =>
      provisionNetwork({
        devices: devices.map((d) => ({ ...d.options(clock), report })),
        confirm: true,
        confirmTimeoutSeconds: 60,
        report,
      })
    ).catch(() => {});
    return events;
  };
  const ok = await reported([fakeDevice({ hostname: "ap" })]);
  t.deepEqual(
    ok.map((e) => ("step" in e ? e.step : e.outcome)),
    ["planning", "configuring", "committing", "confirming", "confirmed", "applied"]
  );
  const cut = progressOf(await reported([fakeDevice({ hostname: "a" }), fakeDevice({ hostname: "b", lockedOutAfterCommit: true })]));
  t.is(cut.outcome, "rolled-back");
  t.is(cut.devices.b, "rolled-back", "unreachable, it rolled itself back and came back");
  t.is(cut.devices.a, "rolled-back");
});

test("events read back as progress: the latest step each, the outcome, a torn line skipped", (t) => {
  const text = [
    JSON.stringify({ at: 1, device: "ap", step: "planning" }),
    JSON.stringify({ at: 2, device: "ap", step: "confirmed" }),
    JSON.stringify({ at: 3, outcome: "applied" }),
    '{"at": 4, "devi',
  ].join("\n");
  t.deepEqual(progressOf(parseEvents(text)), { devices: { ap: "confirmed" }, outcome: "applied" });
});

test("a failing hook is logged by its first words only: never a value it holds", (t) => {
  const { commandLabel } = require("../../apply/run");
  t.is(commandLabel("umask 077; cat > '/etc/x' <<'D'\nprivate\nD"), "umask 077; cat >");
  t.is(commandLabel("uci set wireless.wifinet0.key='secret\nmore'"), "uci set wireless.wifinet0.key");
  t.is(commandLabel("TOKEN=secret /etc/init.d/ddns restart"), "TOKEN");
  t.is(commandLabel("/etc/init.d/avahi-daemon restart"), "/etc/init.d/avahi-daemon restart");
});

test("a failing hook is named in the run's words, its stderr kept, and the run still counts as applied", async (t) => {
  const device = fakeDevice({ hostname: "ap" });
  const clock = virtualClock();
  const options = device.options(clock);
  const hookFails = (session: any) => ({
    ...session,
    execCommand: async (command: string, opts?: { stdin?: string }) =>
      / hooks$/.test(command) ? { stdout: "ONC_STEP hook 2\n", stderr: "it broke", code: 1 } : session.execCommand(command, opts),
  });
  const result = await provisionNetwork({
    devices: [
      {
        ...options,
        connect: async () => hookFails(await options.connect()),
        state: { ...options.state, files: [{ path: "/etc/a", content: "x", runAfterReload: "true" }, { path: "/etc/b", content: "y", runAfterReload: "PASS=secret /etc/init.d/b restart" }] },
      },
    ],
    confirm: true,
    confirmTimeoutSeconds: 90,
  });
  t.false(result.ok);
  if (!result.ok) {
    t.is(result.error.end, "applied-with-problems");
    t.regex(result.error.message, /a run_after_reload hook failed: PASS\nit broke/);
    t.notRegex(result.error.message, /secret/);
  }
});

test.serial("a session dropping mid-configure after a package change rolls the device back, never disarms it", async (t) => {
  const dropping = fakeDevice({
    hostname: "ap2",
    newPackages: ["nlbwmon"],
    onEvent: (e) => e === "packages" && dropping.dropSessions(),
  });
  const error = await failure(t, run([dropping]));
  t.regex(error!.message, /Not connected[\s\S]*No device keeps a change/);
  t.true(dropping.events.includes("rollback-now"));
  t.false(dropping.events.includes("disarm"));
});

test.serial("a dropped session at disarm time is reconnected, not a failed run", async (t) => {
  const a = fakeDevice({ hostname: "a" });
  // Confirming b (its services) cuts the session a was confirmed over.
  const b = fakeDevice({ hostname: "b", services: [{ name: "firewall", running: false }], onEvent: (e) => e === "services" && a.dropSessions() });
  await applies(t, run([a, b]));
  t.true(a.events.includes("disarm") && b.events.includes("disarm"));
  t.true(a.changed && b.changed);
});

test.serial("a device found to have fired at disarm is told it recovered once restored, so it does not reboot", async (t) => {
  const device = fakeDevice({ hostname: "ap", firesBeforeDisarm: true });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /rolled itself back before it could be confirmed/);
  t.true(device.events.indexOf("recovered") > device.events.indexOf("watchdog-fired"));
  t.false(device.changed);
});

test.serial("a rollback is told it recovered only once its restore is done", async (t) => {
  const [a, b] = [fakeDevice({ hostname: "a" }), fakeDevice({ hostname: "b", failOn: "configure" })];
  await failure(t, run([a, b]));
  t.true(a.events.indexOf("recovered") > a.events.indexOf("rollback-now"));
});

test.serial("every device's packages are staged before any watchdog is armed: fetching eats no window", async (t) => {
  const log: string[] = [];
  const devices = ["a", "b"].map((hostname) => fakeDevice({ hostname, log, removes: ["dnsmasq"] }));
  await applies(t, run(devices));
  const lastStage = Math.max(...devices.map((d) => log.indexOf(`${d.hostname}:stage`)));
  const firstArm = log.findIndex((e) => e.endsWith(":arm"));
  t.true(lastStage >= 0 && lastStage < firstArm);
});

test.serial("--no-confirm still starts the declared services, over a new session after the commit", async (t) => {
  const device = fakeDevice({
    hostname: "ap",
    services: [{ name: "firewall", running: false }],
    onEvent: (e) => e === "commit" && device.dropSessions(),
  });
  const clock = virtualClock();
  await quietly(() => provisionNetwork({ devices: [device.options(clock)], confirm: false, confirmTimeoutSeconds: 60 }));
  const events = device.events.filter((e) => e !== "revert");
  t.true(events.indexOf("services") > events.indexOf("commit"));
  t.true(device.changed);
});

test.serial("a removal whose packages cannot all be staged is refused before any device is armed or changed", async (t) => {
  const a = fakeDevice({ hostname: "a" });
  // dnsmasq is what the fake device has installed: removing it stages its cascade.
  const b = fakeDevice({ hostname: "b", removes: ["dnsmasq"], stagesShort: true });
  const error = await failure(t, run([a, b]));
  t.regex(error!.message, /could not be kept for a rollback[\s\S]*Nothing was changed/);
  for (const device of [a, b]) {
    t.false(device.events.includes("arm"), `${device.hostname} never armed`);
    t.false(device.events.includes("configure"));
    t.true(device.events.includes("drop"), `${device.hostname}'s staging taken back`);
  }
});

test.serial("an arm the agent refuses takes the run back: those armed disarmed, the rest's staging dropped, nothing changed", async (t) => {
  const a = fakeDevice({ hostname: "a" });
  const b = fakeDevice({ hostname: "b", arming: "refused" });
  const c = fakeDevice({ hostname: "c" });
  const error = await failure(t, run([a, b, c]));
  t.regex(error!.message, /Failed to arm rollback on b: onc-agent: could not snapshot/);
  t.true(a.events.includes("disarm"), "a was armed: stood down");
  t.true(b.events.includes("drop") && c.events.includes("drop"));
  for (const device of [a, b, c]) {
    t.false(device.events.includes("configure"));
    t.false(device.events.includes("watchdog-fired"), `${device.hostname} never restores, never reboots`);
  }
});

test.serial("a link that drops as the watchdog starts: its arm is taken back over a new connection, so it never fires", async (t) => {
  const device = fakeDevice({ hostname: "ap", arming: "link-drops" });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /Failed to arm rollback on ap: the connection dropped/);
  t.true(device.events.includes("drop"));
  t.false(device.events.includes("watchdog-fired"));
  t.false(device.events.includes("configure"));
});

test.serial("a link that drops mid-configure leaves the device's state unknown: rolled back by its watchdog, never disarmed", async (t) => {
  // No package or file changes: only the dropped link says the device may hold anything.
  const device = fakeDevice({ hostname: "ap", dropsDuringConfigure: true });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /Lost the connection to ap while configuring it[\s\S]*No device keeps a change/);
  t.true(device.events.includes("rollback-now"));
  t.false(device.events.includes("disarm"));
});

test.serial("a step whose answer never comes (a stalled client, the link up) ends at its time limit and rolls back, never hangs", async (t) => {
  // The rig saw it once: the stage step's input never reached the agent, and the run waited forever.
  const device = fakeDevice({ hostname: "ap", stalls: "stage" });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /no answer within 120 s/);
  t.true(device.events.includes("stalled stage"));
  t.true(device.events.includes("rollback-now"));
  t.false(device.events.includes("disarm"));
  t.false(device.events.includes("commit"));
});

test.serial("packages that would not fit the flash are refused at plan, before anything changes", async (t) => {
  const device = fakeDevice({ hostname: "ap", newPackages: ["mwan3", "kmod-batman-adv"], freeKb: 1500 });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /too little room for the packages this run installs \(mwan3, kmod-batman-adv\): they take about 2\.0 MiB, and it has 1\.5 MiB free/);
  t.false(device.events.includes("arm"), "nothing armed, nothing changed");
});

test.serial("a declared config neither on the device nor shipped by OpenWrt is a typo, refused at plan; one listed as new is not", async (t) => {
  const typo = fakeDevice({ hostname: "ap", extraConfig: { firwall: { zone: [{ ".name": "lan" }] } } });
  const error = await failure(t, run([typo]));
  t.regex(error!.message, /"firwall" is not a config on the device, nor one OpenWrt ships: a typo\?/);
  t.false(typo.events.includes("arm"), "nothing armed, nothing changed");
  const custom = fakeDevice({ hostname: "ap", extraConfig: { myapp: { myapp: [{ ".name": "main" }] } }, newConfigs: ["myapp"] });
  const result = await run([custom]);
  t.true(result.ok, "declared new: applied");
});

test.serial("confirming checks the commit's own marker: a finalise script that never writes it is rolled back", async (t) => {
  const device = fakeDevice({ hostname: "ap", commitIncomplete: true });
  const error = await failure(t, run([device]));
  t.regex(error!.message, /did not complete before its connection dropped/);
  t.true(device.events.includes("rollback-now"));
});
