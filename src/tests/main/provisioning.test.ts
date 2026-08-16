import test from "ava";
import { getDeviceScript, getRevertCommands } from "../../getDeviceScript";
import { getInstalledPackages } from "../../utils";
import { OpenWrtState } from "../../openWrtConfigSchema";

/** Routes canned responses by command, like a device would. */
const fakeSsh = (responses: { match: string; stdout: string; code?: number }[]) =>
  ({
    execCommand: async (command: string) => {
      const hit = responses.find((r) => command.includes(r.match));
      return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "", stderr: "" };
    },
  } as any);

// Real `apk info` output: bare names, one per line.
const apkInfo = ["firewall4", "wpad-basic-mbedtls", "curl", "dnsmasq"].join("\n");

test("getInstalledPackages returns bare names from apk info", async (t) => {
  const ssh = fakeSsh([{ match: "apk info", stdout: apkInfo }]);
  const packages = await getInstalledPackages(ssh);
  t.deepEqual(packages, ["firewall4", "wpad-basic-mbedtls", "curl", "dnsmasq"]);
});

// Regression: `apk list --installed` was parsed by splitting on the last "-",
// so `curl-8.19.0-r2` became name "curl-8.19.0". Nothing ever matched the
// installed set, so removals were filtered away and installs always re-ran.
test("package removals survive the installed-set filter", async (t) => {
  const state: OpenWrtState = {
    config: {} as any,
    packagesToUninstall: ["firewall4", "not-installed-pkg"],
    packagesToInstall: [{ packageName: "curl" }, { packageName: "sqm-scripts" }],
  };
  const ssh = fakeSsh([
    { match: "apk info", stdout: apkInfo },
    { match: "managed_files", stdout: "", code: 1 },
  ]);

  const commands = await getDeviceScript({ state, ssh });
  const del = commands.find((c) => c.startsWith("apk del"));
  const add = commands.find((c) => c.startsWith("apk add"));

  // Only the package actually installed is removed.
  t.is(del, "apk del --rdepends firewall4");
  // Only the package not already installed is added.
  t.is(add, "apk add --update-cache sqm-scripts");
});

test("getRevertCommands covers configs outside the built-in set", (t) => {
  // The config schema has a catchall, so a config can drive any UCI package.
  // Those were staged but never reverted, and the final bare `uci commit`
  // commits every package — so a later run committed the leftovers.
  const state: OpenWrtState = {
    config: { network: {}, sqm: {}, dropbear: {}, usteer: {} } as any,
  };
  const reverts = getRevertCommands(state);

  t.true(reverts.includes("uci revert sqm"));
  t.true(reverts.includes("uci revert dropbear"));
  t.true(reverts.includes("uci revert usteer"));
  // Built-ins are still covered even when the config does not mention them.
  t.true(reverts.includes("uci revert firewall"));
  t.true(reverts.includes("uci revert wireless"));
});

test("uci set operations are collapsed into a single uci batch", async (t) => {
  const state: OpenWrtState = {
    config: {
      system: { system: [{ ".name": "system0", hostname: "r1", timezone: "UTC" }] },
    } as any,
  };

  const commands = await getDeviceScript({ state });
  const batch = commands.find((c) => c.startsWith("uci batch"));

  t.truthy(batch);
  // Operations go in with the leading `uci ` stripped, inside a quoted heredoc
  // so values stay literal.
  t.true(batch!.includes("set system.system0.hostname='r1'"));
  t.true(batch!.includes("set system.system0.timezone='UTC'"));
  t.false(batch!.includes("\nuci set "));
  // `uci batch` exits 0 even when an operation fails, so stderr is the signal.
  t.true(batch!.includes("if [ -s /tmp/.onc-uci-err ]"));
  // No individual `uci set` commands remain.
  t.is(commands.filter((c) => c.startsWith("uci set")).length, 0);
});

// The batch is line-oriented, so a value containing a newline would be split
// across lines and misparsed by `uci batch`.
test("uci values containing newlines stay out of the batch", async (t) => {
  const state: OpenWrtState = {
    config: {
      system: {
        system: [
          { ".name": "system0", hostname: "r1", banner: "line one\nline two" },
        ],
      },
    } as any,
  };

  const commands = await getDeviceScript({ state });
  const batch = commands.find((c) => c.startsWith("uci batch"))!;
  const standalone = commands.find(
    (c) => c.startsWith("uci set") && c.includes("line one")
  );

  // The safe operation is batched...
  t.true(batch.includes("set system.system0.hostname='r1'"));
  // ...and the multi-line one is issued on its own, where shell quoting holds.
  t.truthy(standalone);
  t.false(batch.includes("line two"));
});

// UCI lists are ordered. Hoisting every batchable operation ahead of a
// multi-line one would silently move a list element relative to its siblings,
// so the batch is flushed around multi-line commands instead of partitioned.
test("a multi-line value does not reorder the operations around it", async (t) => {
  const state: OpenWrtState = {
    config: {
      system: {
        system: [
          {
            ".name": "system0",
            first: "a",
            multi: "line one\nline two",
            last: "z",
          },
        ],
      },
    } as any,
  };

  const commands = await getDeviceScript({ state });
  const relevant = commands.filter(
    (c) => c.startsWith("uci batch") || c.startsWith("uci set")
  );

  // batch(first) -> standalone(multi) -> batch(last): original order preserved
  t.is(relevant.length, 3);
  t.true(relevant[0].includes("first='a'"));
  t.true(relevant[1].startsWith("uci set") && relevant[1].includes("line one"));
  t.true(relevant[2].includes("last='z'"));
  t.false(relevant[0].includes("last='z'"));
});

test("getDeviceScript reuses a provided installed-package list", async (t) => {
  let apkCalls = 0;
  const ssh = {
    execCommand: async (command: string) => {
      if (command.includes("apk info")) apkCalls += 1;
      return { code: 1, stdout: "", stderr: "" };
    },
  } as any;

  await getDeviceScript({
    state: { config: {} as any, packagesToUninstall: ["firewall4"] },
    ssh,
    installedPackages: ["firewall4"],
  });

  // provisionOpenWrtDevice already fetched the list to warn about removals.
  t.is(apkCalls, 0);
});

test("the script still ends with commit then reload", async (t) => {
  const state: OpenWrtState = {
    config: { system: { system: [{ ".name": "system0", hostname: "r1" }] } } as any,
  };
  const commands = await getDeviceScript({ state });
  t.is(commands[commands.length - 2], "uci commit");
  t.is(commands[commands.length - 1], "reload_config");
});
