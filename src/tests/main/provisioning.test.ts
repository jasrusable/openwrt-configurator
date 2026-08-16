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
  const reverted = (config: string) =>
    reverts.includes(
      `if [ -f /etc/config/${config} ]; then uci revert ${config}; fi`
    );

  t.true(reverted("sqm"));
  t.true(reverted("dropbear"));
  t.true(reverted("usteer"));
  // Built-ins are still covered even when the config does not mention them.
  t.true(reverted("firewall"));
  t.true(reverted("wireless"));
  // `uci revert` exits 1 on a config that is not present, and the revert script
  // runs under `set -e` — unguarded, one absent config would abort every
  // remaining revert, at the worst possible moment.
  t.true(reverts.every((c) => c.startsWith("if [ -f /etc/config/")));
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

// `reload_config` only fires config.change for configs already listed in
// /var/run/config.md5, and installing a package does not refresh that list. So
// a package installed by this run shipped /etc/config/<pkg>, we configured it,
// and the closing reload fired nothing for it — the service kept its shipped
// defaults. Refreshing the baseline after the install puts the new config in
// the list, so the closing reload sees a real diff.
test("the config baseline is refreshed after installs and before staging", async (t) => {
  const state: OpenWrtState = {
    config: {
      system: { system: [{ ".name": "system0", hostname: "r1" }] },
    } as any,
    packagesToInstall: [{ packageName: "sqm-scripts" }],
  };
  const ssh = fakeSsh([
    { match: "apk info", stdout: apkInfo },
    { match: "managed_files", stdout: "", code: 1 },
  ]);

  const commands = await getDeviceScript({ state, ssh });
  const install = commands.findIndex((c) => c.startsWith("apk add"));
  const refresh = commands.indexOf("reload_config");
  // The first command that actually stages something. Not just any `uci`
  // command — the clean-start reverts run earlier and stage nothing.
  const firstStaged = commands.findIndex(
    (c) => c.startsWith("uci batch") || c.startsWith("while uci -q delete")
  );

  t.true(install > -1, "the package is installed");
  t.true(firstStaged > -1, "something is staged");
  // After the install, so the newly shipped /etc/config/<pkg> exists by then.
  t.true(refresh > install, "the baseline is refreshed after the install");
  // Before staging: reload_config compares `uci show`, which includes
  // uncommitted deltas, so refreshing later would bake our own changes into
  // the baseline and the closing reload would fire nothing at all.
  t.true(refresh < firstStaged, "the baseline is refreshed before staging");
});

test("the script still ends with commit then reload", async (t) => {
  const state: OpenWrtState = {
    config: { system: { system: [{ ".name": "system0", hostname: "r1" }] } } as any,
  };
  const commands = await getDeviceScript({ state });
  t.is(
    commands[commands.length - 2],
    "if [ -f /etc/config/system ]; then uci commit system; fi"
  );
  t.is(commands[commands.length - 1], "reload_config");
});

// A bare `uci commit` commits *every* package, so it swept up staged changes
// this tool never made — a half-finished LuCI edit, or leftovers from an
// earlier run that failed and was rolled back.
test("the commit names only the configs this run touched", async (t) => {
  const state: OpenWrtState = {
    config: { network: { interface: [{ ".name": "lan", proto: "static" }] } } as any,
    configSectionsToReset: { firewall: ["zone"] },
  };

  const commands = await getDeviceScript({ state });
  const commits = commands.filter((c) => c.includes("uci commit"));

  t.is(commits.length, 2);
  // Both the config it writes and the config it resets are committed...
  t.true(
    commits.includes("if [ -f /etc/config/network ]; then uci commit network; fi")
  );
  t.true(
    commits.includes("if [ -f /etc/config/firewall ]; then uci commit firewall; fi")
  );
  // ...and nothing commits every package wholesale.
  t.false(commands.includes("uci commit"));
});

// Resolving a config for one device leaves packages behind with no sections —
// ones whose sections were all filtered out by `.if` for this device. Naming
// those in the commit would reintroduce exactly what the narrow commit avoids:
// committing staged changes in a package this run never touches.
test("configs with no operations are neither reverted nor committed", async (t) => {
  const state: OpenWrtState = {
    config: {
      network: { interface: [{ ".name": "lan", proto: "static" }] },
      // Applies to other devices; every section filtered out for this one.
      usteer: {},
      radius: { radius: [] },
    } as any,
    // Present on the device, but nothing of it is being reset.
    configSectionsToReset: { network: ["interface"], dropbear: [] },
  };

  const commands = await getDeviceScript({ state });
  const mentions = (config: string) =>
    commands.some((c) => c.includes(`/etc/config/${config}`));

  t.true(mentions("network"), "a config with real operations is handled");
  t.false(mentions("usteer"), "an empty package is skipped");
  t.false(mentions("radius"), "a package whose sections are all gone is skipped");
  t.false(mentions("dropbear"), "a config with nothing to reset is skipped");
});

// A run that dies before it can revert leaves staged deltas in /tmp/.uci. The
// watchdog restores /etc/config but never touches the delta directory, so those
// changes survive the rollback and the next run's commit would apply them.
test("staged changes are discarded before this run stages its own", async (t) => {
  const state: OpenWrtState = {
    config: { network: { interface: [{ ".name": "lan" }] } } as any,
    packagesToInstall: [{ packageName: "sqm-scripts" }],
  };

  const commands = await getDeviceScript({ state });
  const revert = commands.indexOf(
    "if [ -f /etc/config/network ]; then uci revert network; fi"
  );
  const install = commands.findIndex((c) => c.startsWith("apk add"));
  const firstStaged = commands.findIndex((c) => c.startsWith("uci batch"));

  t.true(revert > -1, "the touched config is reverted first");
  // Before the packages step: `default_postinst` ends with a bare `uci commit`
  // for any package shipping /etc/uci-defaults, which would commit the very
  // leftovers being dropped here.
  t.true(revert < install, "the clean start precedes package installs");
  t.true(revert < firstStaged, "the clean start precedes staging");
});
