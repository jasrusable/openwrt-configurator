import test from "ava";
import { armWatchdogCommands } from "../../provisionOpenWrtDevice";
import { getRemovalCascade } from "../../getDeviceScript";

const arm = (overrides: Partial<Parameters<typeof armWatchdogCommands>[0]> = {}) =>
  armWatchdogCommands({
    runId: "abc123",
    timeoutSeconds: 90,
    filesToRestore: [],
    filesToDelete: [],
    packagesToUninstallOnRollback: [],
    ...overrides,
  });

const watchdogOf = (commands: string[]) =>
  commands.find((c) => c.includes("ONC_WATCHDOG"))!;

test("the snapshot is taken before anything is changed", (t) => {
  const commands = arm();
  const snapshot = commands.findIndex((c) => c.startsWith("cp -a /etc/config"));
  const start = commands.findIndex((c) => c.startsWith("setsid"));
  t.true(snapshot > -1);
  t.true(snapshot < start);
});

// Paths are per-run: with fixed paths a second provision inside the confirm
// window would clear the flag that had already disarmed an earlier watchdog,
// which would then restore a stale snapshot over a healthy device.
test("rollback paths are scoped to the run", (t) => {
  const a = arm({ runId: "aaa" }).join("\n");
  const b = arm({ runId: "bbb" }).join("\n");
  t.true(a.includes("/tmp/onc-rollback-aaa"));
  t.true(a.includes("/tmp/onc-confirmed-aaa"));
  t.false(a.includes("bbb"));
  t.false(b.includes("aaa"));
});

test("a confirmed run cleans up after itself instead of rolling back", (t) => {
  const watchdog = watchdogOf(arm());
  t.true(
    watchdog.includes(
      "if [ -f /tmp/onc-confirmed-abc123 ]; then rm -rf /tmp/onc-rollback-abc123"
    )
  );
  t.true(watchdog.includes("exit 0"));
});

test("rollback restores config, files and newly installed packages", (t) => {
  const commands = arm({
    filesToRestore: ["/etc/hotplug.d/net/20-aql"],
    filesToDelete: ["/etc/hotplug.d/iface/99-new"],
    packagesToUninstallOnRollback: ["sqm-scripts", "luci-app-sqm"],
  });
  const watchdog = watchdogOf(commands);

  // Pre-existing files are archived while they are still intact...
  t.true(
    commands.some(
      (c) =>
        c.startsWith("tar -cf /tmp/onc-rollback-abc123/files.tar") &&
        c.includes("'/etc/hotplug.d/net/20-aql'")
    )
  );
  // ...and put back on rollback.
  t.true(watchdog.includes("tar -xf /tmp/onc-rollback-abc123/files.tar -C /"));
  // Files this run creates did not exist before, so they are removed.
  t.true(watchdog.includes("rm -f '/etc/hotplug.d/iface/99-new'"));
  // Packages this run installs are removed again; this needs no network.
  t.true(watchdog.includes("apk del sqm-scripts luci-app-sqm"));
  t.true(watchdog.includes("cp -a /tmp/onc-rollback-abc123/config /etc/config"));
});

test("paths containing quotes are escaped", (t) => {
  const watchdog = watchdogOf(arm({ filesToDelete: ["/etc/other's file"] }));
  t.true(watchdog.includes(`rm -f '/etc/other'\\''s file'`));
});

test("nothing file- or package-related is emitted when there is nothing to do", (t) => {
  const commands = arm();
  const watchdog = watchdogOf(commands);
  t.false(commands.some((c) => c.startsWith("tar -cf")));
  t.false(watchdog.includes("tar -xf"));
  t.false(watchdog.includes("apk del"));
});

// `--rdepends` removes dependents too, so the named packages understate it:
// removing firewall4 on a stock image takes 21 packages, uhttpd and the whole
// LuCI stack among them.
test("getRemovalCascade reports everything apk would purge", async (t) => {
  const ssh = {
    execCommand: async (command: string) => {
      t.true(command.includes("apk del --simulate --rdepends firewall4"));
      return {
        code: 0,
        stdout: [
          "( 1/3) Purging luci-ssl (26.180.75667~128a781)",
          "( 2/3) Purging uhttpd (2026.06.16~7b1bec45-r1)",
          "( 3/3) Purging firewall4 (2025.03.17~b6e51575-r2)",
        ].join("\n"),
        stderr: "",
      };
    },
  } as any;

  const cascade = await getRemovalCascade({ ssh, packages: ["firewall4"] });
  t.deepEqual(cascade, ["luci-ssl", "uhttpd", "firewall4"]);
});

test("getRemovalCascade falls back to the named packages if apk output is unusable", async (t) => {
  const ssh = {
    execCommand: async () => ({ code: 1, stdout: "ERROR: unknown", stderr: "" }),
  } as any;
  // Reporting an empty list here would be falsely reassuring.
  const cascade = await getRemovalCascade({ ssh, packages: ["firewall4"] });
  t.deepEqual(cascade, ["firewall4"]);
});

test("getRemovalCascade does nothing when there is nothing to remove", async (t) => {
  let called = false;
  const ssh = {
    execCommand: async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;
  t.deepEqual(await getRemovalCascade({ ssh, packages: [] }), []);
  t.false(called);
});
