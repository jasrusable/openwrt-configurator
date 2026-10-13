import test from "ava";
import { spawnSync } from "child_process";
import { ExecResult, Session } from "../../platform";
import {
  boardJson,
  installedPackages,
  managedFiles,
  pendingChanges,
  runProbe,
  runProbes,
} from "../../deviceProbes";

// A session that runs commands with the real local sh, so runProbes' batching
// is checked against an actual shell rather than a fake.
const localSh: Session = {
  execCommand: async (command): Promise<ExecResult> => {
    const r = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status };
  },
  dispose: () => {},
};
const echo = (output: string, code = 0) => ({
  command: `printf '%s' '${output.replace(/'/g, "'\\''")}'; exit ${code}`,
  parse: (r: ExecResult) => r,
});

test("runProbes keeps each probe's output and exit status apart", async (t) => {
  const answers = await runProbes(localSh, {
    multiline: echo("a\nb\n"),
    noNewline: echo("no newline"),
    empty: echo(""),
    failed: echo("partial", 3),
  });
  t.deepEqual(answers.multiline, { stdout: "a\nb\n", stderr: "", code: 0 });
  t.deepEqual(answers.noNewline, { stdout: "no newline", stderr: "", code: 0 });
  t.deepEqual(answers.empty, { stdout: "", stderr: "", code: 0 });
  t.deepEqual(answers.failed, { stdout: "partial", stderr: "", code: 3 });
});

test("a cut-short batch is an error, not a wrong answer", async (t) => {
  const truncated: Session = {
    execCommand: async () => ({
      stdout: "x\n__ONC_PROBE__0\n",
      stderr: "",
      code: null,
    }),
    dispose: () => {},
  };
  await t.throwsAsync(runProbes(truncated, { a: echo("x"), b: echo("y") }), {
    message: /cut short/,
  });
});

const result = (stdout: string, code = 0): ExecResult => ({
  stdout,
  stderr: "",
  code,
});

test("parsers read real device output", (t) => {
  t.is(
    boardJson.parse(
      result(
        '{"model":{"id":"friendlyarm,nanopi-r6s"},"network":{"lan":{"protocol":"static"}}}'
      )
    ).model?.id,
    "friendlyarm,nanopi-r6s"
  );
  t.throws(() => boardJson.parse(result("", 1)), { message: /board\.json/ });
  t.deepEqual(installedPackages.parse(result("busybox\ndropbear\n")), [
    "busybox",
    "dropbear",
  ]);
  t.deepEqual(installedPackages.parse(result("", 127)), [], "no apk at all");
  t.throws(() => installedPackages.parse(result("", 1)));
  t.deepEqual(
    managedFiles("/etc/onc/managed_files").parse(result("", 1)),
    [],
    "no manifest yet"
  );
  t.deepEqual(
    pendingChanges.parse(result("-dropbear.main\nnetwork.lan.ipaddr='x'\n")),
    { dropbear: 1, network: 1 }
  );
});

test("runProbe is the one-probe case", async (t) => {
  t.deepEqual(await runProbe(localSh, echo("ok")), {
    stdout: "ok",
    stderr: "",
    code: 0,
  });
});

// node-ssh trims stdout; the QuickJS transports do not. Batching has to work
// with both — the rig caught the Node path failing on exactly this.
test("runProbes copes with a session that trims its output", async (t) => {
  const trimming: Session = {
    execCommand: async (command) => {
      const r = await localSh.execCommand(command);
      return { ...r, stdout: r.stdout.trim() };
    },
    dispose: () => {},
  };
  const answers = await runProbes(trimming, {
    first: echo(""),
    middle: echo("x\n"),
    last: echo("y"),
  });
  t.is(answers.first.stdout, "");
  t.is(answers.middle.stdout, "x\n");
  t.is(answers.last.stdout, "y");
  t.is(answers.last.code, 0);
});

test("package space: apk 3's totals before and after, against the overlay's free space (recorded on 25.12.5)", (t) => {
  const { apkTotalKb, packageSpace } = require("../../deviceProbes") as typeof import("../../deviceProbes");
  t.is(apkTotalKb("OK: 12.8 MiB in 155 packages"), 12.8 * 1024);
  t.is(apkTotalKb("OK: 900 KiB in 3 packages"), 900);
  t.is(apkTotalKb("ERROR: unable to select packages"), undefined);
  const probe = packageSpace({ add: ["mwan3"], remove: ["wpad-basic-mbedtls"] });
  const parse = (stdout: string) => probe.parse({ stdout, stderr: "", code: 0 });
  t.deepEqual(
    parse("OK: 10.6 MiB in 131 packages\nOK: 10.1 MiB in 130 packages\nOK: 12.8 MiB in 155 packages\noverlayfs:/overlay 5120 3072 2048 60% /overlay\n"),
    { needKb: Math.max(0, (12.8 - 10.6 + (10.1 - 10.6)) * 1024), freeKb: 2048 }
  );
  t.is(parse("ERROR: no index\nOK: 10.6 MiB in 131 packages\nOK: 1 MiB in 1 packages\nx 1 1 1 1 /\n"), undefined, "apk could not say: not checked");
});

test("Wi-Fi stations: each client's MAC from iwinfo's assoclist, lower case, once", (t) => {
  const { wifiStations } = require("../../deviceProbes") as typeof import("../../deviceProbes");
  const stdout = [
    "AA:BB:CC:DD:EE:01  -45 dBm / -95 dBm (SNR 50)  120 ms ago",
    "\tRX: 866.7 MBit/s, VHT-MCS 9, 80MHz, VHT-NSS 2                    1234 Pkts.",
    "\tTX: 780.0 MBit/s, VHT-MCS 8, 80MHz, VHT-NSS 2                     987 Pkts.",
    "\texpected throughput: 500.0 MBit/s",
    "",
    "aa:bb:cc:dd:ee:02  -60 dBm / -95 dBm (SNR 35)  2000 ms ago",
    "AA:BB:CC:DD:EE:01  -45 dBm / -95 dBm (SNR 50)  120 ms ago",
    "No station connected",
  ].join("\n");
  t.deepEqual(wifiStations.parse({ stdout, stderr: "", code: 0 }), ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"]);
});

test("service triggers: the configs each service's reload triggers watch, as procd lists them (recorded on 25.12.5)", (t) => {
  const { serviceTriggers } = require("../../deviceProbes") as typeof import("../../deviceProbes");
  const stdout = JSON.stringify({
    dnsmasq: { instances: {}, triggers: [["config.change", ["if", ["eq", "package", "dhcp"], ["run_script", "/etc/init.d/dnsmasq", "reload"]]], ["config.change", ["if", ["eq", "package", "system"], ["run_script", "/etc/init.d/dnsmasq", "reload"]]]] },
    cron: { instances: { instance1: { running: true } } },
    dropbear: { triggers: [["config.change", ["if", ["eq", "package", "dropbear"], ["run_script", "/etc/init.d/dropbear", "reload"]]]] },
  });
  t.deepEqual(serviceTriggers.parse({ stdout, stderr: "", code: 0 }), { dnsmasq: ["dhcp", "system"], cron: [], dropbear: ["dropbear"] });
  t.deepEqual(serviceTriggers.parse({ stdout: "not json", stderr: "", code: 1 }), {});
});
