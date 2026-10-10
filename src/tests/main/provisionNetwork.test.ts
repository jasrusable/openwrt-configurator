import test from "ava";
// Serial: these silence console globally while a run prints its progress.
import { fakeDevice, virtualClock } from "../helpers/fakeDevice";
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
});
