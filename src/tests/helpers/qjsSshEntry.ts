// Bundled and run under qjs by qjsSsh.test.ts, with a fake dbclient (and,
// where there is none, setsid) first on PATH: which known_hosts dbclient is
// given, what it records, and local commands killed whole at their limit.
// ONC_TEST_DIR: a scratch directory; HOME: one whose ~/.ssh/known_hosts must
// stay untouched.
import "../../platforms/qjsGlobals";
import { qjsPlatform as platform } from "../../platforms/qjs";
import { messageOf } from "../../result";
import { SshTarget } from "../../platform";

const results: string[] = [];
const check = (name: string, ok: boolean, detail: unknown) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);

const dir = platform.env("ONC_TEST_DIR")!;
const home = platform.env("HOME")!;
const knownHostsFile = `${dir}/known_hosts`;
const target = (more: Partial<SshTarget> = {}): SshTarget => ({
  host: "192.0.2.10",
  username: "root",
  password: "x",
  knownHostsFile,
  readyTimeout: 5000,
  keepaliveInterval: 5000,
  keepaliveCountMax: 3,
  ...more,
});
/** The key the fake device shows next: dbclient's reads it from here. */
const shows = (key: string) => platform.writeTextFile(`${dir}/shows`, key);
const read = (path: string) => {
  try {
    return platform.readTextFile(path);
  } catch {
    return "";
  }
};
const refusal = async (t: SshTarget) => {
  try {
    (await platform.connect(t)).dispose();
    return "connected";
  } catch (e) {
    return messageOf(e);
  }
};

const main = async () => {
  const rootHosts = read(`${home}/.ssh/known_hosts`);

  shows("ssh-ed25519 AAAAone");
  const first = await platform.connect(target());
  const echoed = await first.execCommand("cat", { stdin: "hello" });
  first.dispose();
  check("first use: recorded in the file given", read(knownHostsFile) === "192.0.2.10 ssh-ed25519 AAAAone\n", read(knownHostsFile));
  const [, givenHome, y] = /^home=(\S+) y=(\d)$/m.exec(read(`${dir}/log`)) ?? [];
  check("first use: accepted with -y, from a home of its own", !!givenHome && givenHome !== home && y === "1", read(`${dir}/log`));
  check("a command's input arrives whole", echoed.stdout === "hello" && echoed.code === 0, echoed);

  const again = await platform.connect(target());
  const strict = await again.execCommand("cat", { stdin: "hello" });
  again.dispose();
  check("known: checked without -y, and its input arrives whole", /y=0\n$/.test(read(`${dir}/log`)) && strict.stdout === "hello", { log: read(`${dir}/log`), strict });

  shows("ssh-ed25519 AAAAtwo");
  const changed = await refusal(target());
  check("a changed key is refused, naming the file", changed.includes("has changed") && changed.includes(knownHostsFile), changed);

  shows("ssh-rsa AAAAthree");
  const otherType = await refusal(target());
  check("a key of another type is refused, not added", otherType !== "connected" && !read(knownHostsFile).includes("AAAAthree"), { otherType, file: read(knownHostsFile) });

  shows("ssh-ed25519 AAAAtwo");
  const pinned = await platform.connect(target({ hostKey: { type: "ssh-ed25519", key: "AAAAtwo" } }));
  const pinnedRun = await pinned.execCommand("echo ok");
  pinned.dispose();
  check("a pinned key alone is checked, the file untouched", pinnedRun.stdout === "ok\n" && read(knownHostsFile) === "192.0.2.10 ssh-ed25519 AAAAone\n", pinnedRun);

  const neither = await refusal(target({ knownHostsFile: undefined }));
  check("no file and no key: refused", /no known_hosts file and no host key/.test(neither), neither);

  check("root's own known_hosts untouched", read(`${home}/.ssh/known_hosts`) === rootHosts, read(`${home}/.ssh/known_hosts`));

  // A local command past its limit: the subshell it started goes with it.
  const local = await platform.connect(target({ host: "localhost" }));
  const marker = `${dir}/still-running`;
  const started = Date.now();
  const limited = await local.execCommand(`( sleep 1; touch ${marker} ) & wait`, { timeoutMs: 300 });
  await platform.sleep(1500);
  local.dispose();
  check("a local command past its limit is killed with its children", limited.timedOut === true && Date.now() - started < 4000 && platform.fileMode(marker) === undefined, limited);
  const ran = await platform.run(["sh", "-c", `( sleep 1; touch ${marker} ) & wait`], { timeoutMs: 300 });
  await platform.sleep(1500);
  check("run's time limit too", ran.timedOut === true && platform.fileMode(marker) === undefined, ran);

  platform.privateDir(`${dir}/private/inner`);
  check("a private directory is made owner-only", platform.fileMode(`${dir}/private/inner`) === 0o700, platform.fileMode(`${dir}/private/inner`));
  await platform.run(["sh", "-c", `mkdir -m 700 ${dir}/elsewhere && ln -s ${dir}/elsewhere ${dir}/link && mkdir -m 777 ${dir}/open`]);
  const refused = (path: string) => {
    try {
      platform.privateDir(path);
      return false;
    } catch {
      return true;
    }
  };
  check("a link or an open directory is refused", refused(`${dir}/link`) && refused(`${dir}/open`), [refused(`${dir}/link`), refused(`${dir}/open`)]);

  platform.writeFileAtomic(`${dir}/atomic`, "data\n", 0o640);
  check("an atomic write: its data and exactly its mode", read(`${dir}/atomic`) === "data\n" && platform.fileMode(`${dir}/atomic`) === 0o640, platform.fileMode(`${dir}/atomic`));
};

main().then(
  () => {
    console.log(results.join("\n"));
    platform.exit(0);
  },
  (e) => {
    console.log(results.join("\n"));
    console.error(`ssh check crashed: ${messageOf(e)}`);
    platform.exit(1);
  }
);
