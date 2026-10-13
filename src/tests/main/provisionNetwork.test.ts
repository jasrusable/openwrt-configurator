import test from "ava";
// Serial: these silence console globally while a run prints its progress.
import { fakeDevice, virtualClock } from "../helpers/fakeDevice";
import { ApplyEvent, parseEvents, progressOf } from "../../applyEvents";
import { provisioningOrder, provisionNetwork } from "../../provisionNetwork";

const quietly = async <T>(fn: () => Promise<T>) => {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
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
  await run([device]);
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
  await run([device]);
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
  const error = await t.throwsAsync(run([device]));
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
  const error = await t.throwsAsync(run([device]));
  t.regex(error!.message, /No device keeps a change/);
  t.false(device.events.includes("commit"));
  t.true(device.events.includes("rollback-now"));
  t.false(device.events.includes("disarm"));
});

test.serial("confirming runs to the earliest watchdog's deadline: a slow device never outlasts another's window", async (t) => {
  const first = fakeDevice({ hostname: "router" });
  const slow = fakeDevice({ hostname: "far-ap", slowReconnectMs: 70_000 });
  const error = await t.throwsAsync(run([first, slow]));
  t.regex(error!.message, /no device keeps a change|rolled itself back/i);
  // Neither device keeps the change, and none was reported confirmed while rolled back.
  t.false(first.changed);
  t.false(slow.changed);
  t.false(first.events.includes("disarm") && first.events.includes("watchdog-fired"));
});

test.serial("a commit the link dropped partway through is rolled back now, never confirmed", async (t) => {
  const device = fakeDevice({ hostname: "ap", commitIncomplete: true });
  const error = await t.throwsAsync(run([device]));
  t.regex(error!.message, /did not complete/);
  t.true(device.events.includes("rollback-now"));
  t.false(device.events.includes("disarm"));
});

test.serial("services start before the settle and the confirming reconnect: inside the rollback", async (t) => {
  const device = fakeDevice({ hostname: "ap", services: [{ name: "firewall", running: false }] });
  await run([device]);
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
  await run(devices);
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
  const error = await t.throwsAsync(run([a, b, c]));
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
  const error = await t.throwsAsync(run([a, b]));
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

test("a failing command is logged by its first words only: never a batch's values or a file's content", (t) => {
  const { commandLabel } = require("../../devicePhases");
  t.is(commandLabel("uci batch <<'ONC'\nset wireless.x.key='secret'\nONC"), "uci batch");
  t.is(commandLabel("umask 077; cat > '/etc/x' <<'D'\nprivate\nD"), "umask 077; cat >");
  t.is(commandLabel("uci set wireless.wifinet0.key='secret\nmore'"), "uci set wireless.wifinet0.key");
  t.is(commandLabel("apk add --update-cache nlbwmon"), "apk add --update-cache nlbwmon");
});
