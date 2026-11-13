// The odhcpd watcher: restarts odhcpd while a network with a link has no
// odhcpd advertising on it (25.12's odhcpd drops a network whose link was
// down when it started or reloaded: openwrt/odhcpd fad2c8b4), read from its
// all-routers membership beside the kernel's.
import test from "ava";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { compileIntent } from "../../intent/compile";
import { watcher } from "../../intent/patches/odhcpd-ra-restart";
import { sampleIntent } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const allRouters = "ff020000000000000000000000000002";

/** One check, against a made-up /proc and /sys: each device's carrier, odhcpd's join or not. */
const check = (devices: { name: string; carrier: boolean; odhcpd: boolean; forwarding?: number }[]) => {
  const dir = tempDir("odhcpd-watch");
  const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("pidof", "exit 0");
  stub("logger", `echo "$*" >> ${dir}/said`);
  stub("sleep", "true");
  for (const d of devices) {
    mkdirSync(join(dir, "net", d.name), { recursive: true });
    writeFileSync(join(dir, "net", d.name, "carrier"), d.carrier ? "1\n" : "0\n");
    mkdirSync(join(dir, "conf", d.name), { recursive: true });
    writeFileSync(join(dir, "conf", d.name, "forwarding"), `${d.forwarding ?? 1}\n`);
  }
  writeFileSync(
    join(dir, "igmp6"),
    devices.map((d, i) => `${i + 2}    ${d.name}    ${allRouters}     ${(d.forwarding ?? 1) + (d.odhcpd ? 1 : 0)} 00000004 0\n`).join("")
  );
  const script = watcher(devices.map((d) => d.name))
    .replace(/\/sys\/class\/net/g, join(dir, "net"))
    .replace(/\/proc\/net\/igmp6/g, join(dir, "igmp6"))
    .replace(/\/proc\/sys\/net\/ipv6\/conf/g, join(dir, "conf"))
    .replace(/\/etc\/init\.d\/odhcpd restart/g, `echo restarted >> ${dir}/log`);
  writeFileSync(join(dir, "watch"), script);
  spawnSync("sh", [join(dir, "watch"), "once"], { env: { PATH: `${dir}:/usr/bin:/bin` } });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return { restarted: read("log").includes("restarted"), said: read("said") };
};

test("odhcpd advertising on every network with a link: left alone", (t) => {
  t.false(check([{ name: "br-lan.1", carrier: true, odhcpd: true }, { name: "br-lan.3", carrier: false, odhcpd: false }]).restarted);
});

test("a network with a link and no odhcpd on it: restarted, and said why", (t) => {
  const { restarted, said } = check([{ name: "br-lan.1", carrier: true, odhcpd: true }, { name: "br-lan.3", carrier: true, odhcpd: false }]);
  t.true(restarted);
  t.regex(said, /not advertising on br-lan\.3/);
});

test("the kernel's own join is not odhcpd's: without forwarding, one user is odhcpd", (t) => {
  t.false(check([{ name: "br-lan.1", carrier: true, odhcpd: true, forwarding: 0 }]).restarted);
  t.true(check([{ name: "br-lan.1", carrier: true, odhcpd: false, forwarding: 1 }]).restarted);
});

test("the router watches each network with IPv6, by its device", (t) => {
  const plan = compileIntent(sampleIntent());
  const script = plan.files.find((f) => f.path === "/usr/libexec/onc/odhcpd-watch")!.content;
  t.regex(script, /^devices="br-lan\.1( br-lan\.\d+)*"$/m);
  t.true(plan.files.some((f) => f.path === "/etc/init.d/onc-odhcpd-watch"));
});
