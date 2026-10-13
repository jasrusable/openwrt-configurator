import test from "ava";
import { stateOf, keepsOf } from "../helpers/fixtures";
import { AgentRecord, decodeRecords } from "../../agent/records";
import { finaliseRecords, getDeviceScript, prepareRecords, servicesRecords, stageRecords } from "../../getDeviceScript";
import {
  installedPackages,
  runProbe,
  summarisePendingChanges,
} from "../../deviceProbes";

/** Routes canned responses by command, like a device would. */
const fakeSsh = (
  responses: { match: string; stdout: string; code?: number }[]
) =>
  ({
    execCommand: async (command: string) => {
      const hit = responses.find((r) => command.includes(r.match));
      return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "", stderr: "" };
    },
  } as any);

// Real `apk info` output: bare names, one per line.
const apkInfo = ["firewall4", "wpad-basic-mbedtls", "curl", "dnsmasq"].join(
  "\n"
);

test("getInstalledPackages returns bare names from apk info", async (t) => {
  const ssh = fakeSsh([{ match: "apk info", stdout: apkInfo }]);
  const packages = await runProbe(ssh, installedPackages);
  t.deepEqual(packages, ["firewall4", "wpad-basic-mbedtls", "curl", "dnsmasq"]);
});

// Regression: `apk list --installed` was parsed by splitting on the last "-",
// so `curl-8.19.0-r2` became name "curl-8.19.0". Nothing ever matched the
// installed set, so removals were filtered away and installs always re-ran.
test("package removals survive the installed-set filter", async (t) => {
  const state = stateOf({
        packages: { add: ["curl", "sqm-scripts"], remove: ["firewall4", "not-installed-pkg"] },
  });
  const records = prepareRecords({ state, installedPackages: apkInfo.split("\n") });
  // Only the package actually installed is removed, only the one not installed added.
  t.deepEqual(records.filter((r) => r.kind === "remove" || r.kind === "add"), [
    { kind: "remove", name: "firewall4" },
    { kind: "add", name: "sqm-scripts" },
  ]);
});

const ops = (records: AgentRecord[]) => records.flatMap((r) => (r.kind === "batch" ? [r] : []));

test("uci operations go to the device as one batch, values quoted as uci batch reads them", (t) => {
  const state = stateOf({
    config: { system: { system: [{ ".name": "system0", hostname: "r1", timezone: "UTC", note: "Jason's" }] } } as any,
  });
  const records = stageRecords({ state, current: {} });
  t.deepEqual(ops(records), [
    {
      kind: "batch",
      operations: ["set system.system0=system", "set system.system0.hostname='r1'", "set system.system0.timezone='UTC'", "set system.system0.note='Jason'\\''s'"],
    },
  ]);
});

// The batch is line-oriented, so a value containing a newline would be split
// across lines and misparsed by `uci batch`. UCI lists are ordered, so it is
// not hoisted either: the batch is split around it.
test("a value spanning lines goes on its own, in place, between batches", (t) => {
  const state = stateOf({
    config: { system: { system: [{ ".name": "system0", first: "a", multi: "line one\nline two", last: "z" }] } } as any,
  });
  const uci = stageRecords({ state, current: {} }).filter((r) => r.kind === "batch" || r.kind === "set");
  t.deepEqual(uci, [
    { kind: "batch", operations: ["set system.system0=system", "set system.system0.first='a'"] },
    { kind: "set", key: "system.system0.multi", value: "line one\nline two" },
    { kind: "batch", operations: ["set system.system0.last='z'"] },
  ]);
});

test("the wipe comes first in the batch: every section of the device's that is not kept, by exact name", (t) => {
  const state = stateOf({ config: { network: { interface: [{ ".name": "lan", proto: "static" }] } } as any, keep: keepsOf("luci.*") });
  const [batch] = ops(
    stageRecords({
      state,
      current: {
        network: [{ type: "interface", name: "old", options: {} }, { type: "device", options: {} }],
        luci: [{ type: "core", name: "main", options: {} }],
      },
    })
  );
  t.deepEqual(batch.kind === "batch" && batch.operations.slice(0, 3), ["delete network.old", "delete network.@device[0]", "set network.lan=interface"]);
});

test("files dropped from the config are removed from the device", (t) => {
  const state = stateOf({ files: [{ path: "/etc/kept", content: "x" }] });
  const records = stageRecords({ state, current: {}, managedFiles: ["/etc/kept", "/etc/dropped", "/etc/init.d/watcher"] });
  t.deepEqual(
    records.filter((r) => r.kind === "remove-file"),
    [
      { kind: "remove-file", path: "/etc/dropped" },
      { kind: "remove-file", path: "/etc/init.d/watcher" },
    ]
  );
});

// A bare `uci commit` commits *every* package, so it swept up staged changes
// this tool never made — a half-finished LuCI edit, or leftovers from an
// earlier run that failed and was rolled back.
test("the commit names only the configs this run touched", (t) => {
  const state = stateOf({
    config: { network: { interface: [{ ".name": "lan", proto: "static" }] } } as any,
    keep: keepsOf("luci.*"),
  });
  const records = finaliseRecords({
    state,
    current: {
      firewall: [{ type: "zone", options: {} }],
      luci: [{ type: "core", name: "main", options: {} }],
    },
  });
  // The config it writes and the config it resets, by name; never luci, never everything.
  t.deepEqual(records, [
    { kind: "commit", config: "firewall" },
    { kind: "commit", config: "network" },
  ]);
});

// Resolving a config for one device leaves packages behind with no sections —
// ones whose sections were all filtered out by `.if` for this device. Naming
// those in the commit would reintroduce exactly what the narrow commit avoids:
// committing staged changes in a package this run never touches.
test("configs with no operations are neither seeded nor committed", (t) => {
  const state = stateOf({
    config: {
      network: { interface: [{ ".name": "lan", proto: "static" }] },
      // Applies to other devices; every section filtered out for this one.
      usteer: {},
      radius: { radius: [] },
    } as any,
    // Present on the device, but kept.
    keep: keepsOf("dropbear.*"),
  });
  const current = {
    network: [{ type: "interface", name: "lan", options: {} }],
    dropbear: [{ type: "dropbear", name: "main", options: {} }],
  };
  t.deepEqual(finaliseRecords({ state, current }), [{ kind: "commit", config: "network" }]);
  t.deepEqual(
    prepareRecords({ state }).map((r) => r.kind === "seed" && r.path),
    ["/etc/config/network"]
  );
});

test("the commit covers packages whose sections are only reset", (t) => {
  const state = stateOf({
    config: { system: { system: [{ ".name": "s" }] }, sqm: {} } as any,
    keep: keepsOf("dhcp.dnsmasq"),
  });
  const current = {
    attendedsysupgrade: [{ type: "server", options: {} }],
    dhcp: [{ type: "dnsmasq", options: {} }],
  };
  // sqm and dhcp have nothing staged (dhcp's only section type is kept), so
  // naming them would commit someone else's changes; attendedsysupgrade only
  // has sections wiped.
  t.deepEqual(
    finaliseRecords({ state, current }).map((r) => r.kind === "commit" && r.config),
    ["attendedsysupgrade", "system"]
  );
});

test("the dry run shows each verb with its records, in the order provision runs them", (t) => {
  const state = stateOf({
    config: { system: { system: [{ ".name": "s", hostname: "r1" }] } } as any,
    services: [{ name: "dnsmasq", running: true }],
    files: [{ path: "/etc/x", content: "y", runAfterReload: "HOOK" }],
  });
  const script = getDeviceScript({ state });
  t.deepEqual(
    script.map((verb) => verb.split(" ")[1]),
    ["prepare", "stage", "finalise", "services", "hooks"]
  );
  // Each as it is sent: its records, then their end.
  t.deepEqual(decodeRecords(script[2].split("\n").slice(1, -1).join("\n") + "\n"), [{ kind: "commit", config: "system" }]);
  t.deepEqual(getDeviceScript({ state: stateOf() }).length, 3, "no services or hooks: not shown");
});

test("pending changes are summarised per package, without values", (t) => {
  const summary = summarisePendingChanges(
    [
      "-dropbear.main",
      "wireless.default_radio0.key='hunter2'",
      "network.lan.dns+='1.1.1.1'",
      "network.wan=interface",
      "",
    ].join("\n")
  );
  t.deepEqual(summary, { dropbear: 1, wireless: 1, network: 2 });
  t.false(JSON.stringify(summary).includes("hunter2"));
});

test("a service declared off is disabled and stopped, one declared on enabled and started", (t) => {
  t.deepEqual(servicesRecords(stateOf({ services: [{ name: "mwan3", running: false, enabled: false }, { name: "dnsmasq", running: true }] })), [
    { kind: "enable", name: "dnsmasq" },
    { kind: "disable", name: "mwan3" },
  ]);
});
