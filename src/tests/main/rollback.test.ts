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

// Doing `mv /etc/config` before the copy meant a failed copy — an overlay full
// from `apk add`, which is exactly when rollbacks fire — rebooted the device
// with no /etc/config at all, the one failure needing physical recovery.
test("the restored config is staged before the live one is moved aside", (t) => {
  const watchdog = watchdogOf(arm());
  const swap = watchdog.split("\n").find((l) => l.startsWith("if cp -a"))!;
  t.truthy(swap);
  t.true(swap.includes("/etc/config.onc-new"));
  // the move only happens inside the success branch of the copy
  t.true(swap.indexOf("cp -a") < swap.indexOf("mv /etc/config"));
  t.true(swap.includes("else"));
  // and no unguarded move survives
  t.false(watchdog.split("\n").some((l) => l.trim().startsWith("mv /etc/config /etc/config.onc-failed")));
});

// Staging packages is network-bound, so it happens before the watchdog starts
// counting; clearing the directory therefore cannot be part of arming.
test("arming does not clear the rollback directory", (t) => {
  const commands = arm();
  t.false(commands.some((c) => c.startsWith("rm -rf /tmp/onc-rollback-abc123 ")));
  t.false(commands.some((c) => c.startsWith("mkdir -p /tmp/onc-rollback-abc123")));
});

// Recovery is graduated: a reload that restores access should not cost an
// outage, but a reload is not proof the operator can reach the device, so the
// reboot stays as the fallback.
test("the default mode reverts, reloads, then reboots only if access does not return", (t) => {
  const watchdog = watchdogOf(arm());
  const reload = watchdog.indexOf("reload_config");
  // The recovered flag is also named in the early cleanup line, so anchor on
  // the wait loop itself rather than the first mention of the path.
  const wait = watchdog.indexOf("while [ $i -lt");
  const reboot = watchdog.lastIndexOf("\nreboot");

  t.true(reload > -1, "reloads services");
  t.true(wait > reload, "waits for the recovered flag after reloading");
  t.true(reboot > wait, "reboots only after the wait");
  // The wait exits early and cleanly when access comes back.
  t.true(watchdog.includes('logger -t onc "revert restored access, no reboot needed"'));
});

test("mode=reboot skips the reload and reboots straight away", (t) => {
  const watchdog = watchdogOf(arm({ mode: "reboot" }));
  t.false(watchdog.includes("reload_config"));
  t.false(watchdog.includes("while [ $i -lt"), "no wait loop");
  // The element wraps the script in a heredoc, so the delimiter is last; the
  // final actual command should be the reboot.
  const body = watchdog.trimEnd().split("\n").slice(0, -1);
  t.is(body[body.length - 1], "reboot");
});

test("mode=reload never reboots", (t) => {
  const watchdog = watchdogOf(arm({ mode: "reload" }));
  t.true(watchdog.includes("reload_config"));
  t.true(watchdog.includes("while [ $i -lt"), "waits for the recovered flag");
  // `reboot` must not appear as a command anywhere in this mode.
  t.false(watchdog.split("\n").some((l) => l.trim() === "reboot"));
  t.true(watchdog.includes("forbids rebooting"));
});

test("wireless gets an explicit reload, since procd triggers do not cover it", (t) => {
  t.false(watchdogOf(arm()).includes("wifi reload"));
  t.true(watchdogOf(arm({ reloadWireless: true })).includes("wifi reload"));
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
