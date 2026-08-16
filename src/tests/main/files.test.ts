import test from "ava";
import { getDeviceScript } from "../../getDeviceScript";
import { OpenWrtState } from "../../openWrtConfigSchema";

test("getDeviceScript writes managed files + manifest before commit", async (t) => {
  const content = '#!/bin/sh\necho "$ACTION"\n';
  const runAfter = "ACTION=add INTERFACE=phy1-ap0 sh /etc/hotplug.d/net/20-aql";
  const state: OpenWrtState = {
    // A real config, so the run actually has something to commit to order
    // against — the commit now names each touched config rather than being a
    // bare `uci commit`.
    config: {
      system: { system: [{ ".name": "system0", hostname: "r1" }] },
    } as any,
    files: [
      {
        path: "/etc/hotplug.d/net/20-aql",
        content,
        mode: "0755",
        run_after: runAfter,
      },
    ],
  };

  const commands = await getDeviceScript({ state });
  const commitIdx = commands.findIndex((c) => c.includes("uci commit"));
  t.true(commitIdx > -1, "the touched config is committed");

  const writeCmd = commands.find(
    (c) => c.includes("'/etc/hotplug.d/net/20-aql'") && c.startsWith("mkdir -p")
  );
  t.truthy(writeCmd);

  // run_after runs immediately after the file is written, before `uci commit`.
  // (Use run_after_reload for anything that needs the config to be live.)
  const writeCmdIdx = commands.indexOf(writeCmd!);
  t.is(commands[writeCmdIdx + 1], runAfter);
  t.true(writeCmdIdx + 1 < commitIdx);
  // Quoted heredoc (no base64 — busybox often lacks it) keeps content literal.
  t.true(writeCmd!.includes("cat > '/etc/hotplug.d/net/20-aql' <<'ONC_EOF'"));
  t.true(writeCmd!.includes(content));
  t.true(writeCmd!.includes("mkdir -p '/etc/hotplug.d/net'"));
  t.true(writeCmd!.includes("chmod 0755 '/etc/hotplug.d/net/20-aql'"));

  // A manifest of managed files is written so stale files can be pruned later.
  t.truthy(commands.find((c) => c.includes("'/etc/onc/managed_files'")));

  // Files are written before `uci commit` (clean rollback on failure).
  const writeIdx = commands.findIndex((c) => c.includes("20-aql"));
  t.true(writeIdx > -1 && writeIdx < commitIdx);
});

// `run_after` fires as soon as the file is written, which is before the config
// is live — a hotplug script aimed at an interface this provision creates would
// run against an interface that does not exist yet, silently doing nothing.
// `run_after_reload` runs once the config has been committed and reloaded.
test("run_after_reload runs after the config is live, run_after before", async (t) => {
  const state: OpenWrtState = {
    config: {
      wireless: { "wifi-iface": [{ ".name": "wifinet0", ssid: "x" }] },
    } as any,
    files: [
      {
        path: "/etc/hotplug.d/net/20-aql",
        content: "#!/bin/sh\n",
        run_after: "EARLY",
        run_after_reload: "LATE",
      },
    ],
  };

  const commands = await getDeviceScript({ state });
  const early = commands.indexOf("EARLY");
  const late = commands.indexOf("LATE");
  const commitIdx = commands.findIndex((c) => c.includes("uci commit"));
  const reloadIdx = commands.lastIndexOf("reload_config");

  t.true(early > -1 && late > -1, "both hooks are emitted");
  t.true(early < commitIdx, "run_after fires before the commit");
  t.true(late > reloadIdx, "run_after_reload fires after the reload");
});

test("a file with no run_after_reload adds nothing after the reload", async (t) => {
  const state: OpenWrtState = {
    config: { system: { system: [{ ".name": "system0", hostname: "r1" }] } } as any,
    files: [{ path: "/etc/x", content: "y" }],
  };
  const commands = await getDeviceScript({ state });
  t.is(commands[commands.length - 1], "reload_config");
});

test("getDeviceScript emits no file commands when there are no files", async (t) => {
  const commands = await getDeviceScript({ state: { config: {} as any } });
  t.falsy(commands.find((c) => c.includes("/etc/onc/managed_files")));
});
