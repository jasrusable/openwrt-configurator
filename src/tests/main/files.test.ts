import test from "ava";
import { getDeviceScript } from "../../getDeviceScript";
import { OpenWrtState } from "../../openWrtConfigSchema";

test("getDeviceScript writes managed files + manifest before commit", async (t) => {
  const content = '#!/bin/sh\necho "$ACTION"\n';
  const runAfter = "ACTION=add INTERFACE=phy1-ap0 sh /etc/hotplug.d/net/20-aql";
  const state: OpenWrtState = {
    config: {} as any,
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

  const writeCmd = commands.find(
    (c) => c.includes("'/etc/hotplug.d/net/20-aql'") && c.startsWith("mkdir -p")
  );
  t.truthy(writeCmd);

  // run_after runs immediately after the file is written, before `uci commit`.
  const writeCmdIdx = commands.indexOf(writeCmd!);
  t.is(commands[writeCmdIdx + 1], runAfter);
  t.true(writeCmdIdx + 1 < commands.indexOf("uci commit"));
  // Quoted heredoc (no base64 — busybox often lacks it) keeps content literal.
  t.true(writeCmd!.includes("cat > '/etc/hotplug.d/net/20-aql' <<'ONC_EOF'"));
  t.true(writeCmd!.includes(content));
  t.true(writeCmd!.includes("mkdir -p '/etc/hotplug.d/net'"));
  t.true(writeCmd!.includes("chmod 0755 '/etc/hotplug.d/net/20-aql'"));

  // A manifest of managed files is written so stale files can be pruned later.
  t.truthy(commands.find((c) => c.includes("'/etc/onc/managed_files'")));

  // Files are written before `uci commit` (clean rollback on failure).
  const commitIdx = commands.indexOf("uci commit");
  const writeIdx = commands.findIndex((c) => c.includes("20-aql"));
  t.true(writeIdx > -1 && writeIdx < commitIdx);
});

test("getDeviceScript emits no file commands when there are no files", async (t) => {
  const commands = await getDeviceScript({ state: { config: {} as any } });
  t.falsy(commands.find((c) => c.includes("/etc/onc/managed_files")));
});
