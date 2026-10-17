import test from "ava";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "../helpers/tempDir";

// QuickJS's SSH over dbclient (a router's client), against a fake dbclient
// that keeps to its known_hosts as the real one does (verified on 25.12.5):
// $HOME/.ssh/known_hosts only; with -y an unknown host's key is added; a
// changed key refused; a host known by another key type asks, on stdin.
const hasQjs = spawnSync("sh", ["-c", "command -v qjs"]).status === 0;
const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
const qjsTest = hasQjs ? test : test.skip;

const fakeDbclient = `#!/bin/sh
y=0
while [ $# -gt 2 ]; do
  case "$1" in -y) y=1; shift ;; -K|-i|-l) shift 2 ;; *) break ;; esac
done
host=$1 command=$2
echo "home=$HOME y=$y" >> "$ONC_TEST_DIR/log"
known=$HOME/.ssh/known_hosts
set -- $(cat "$ONC_TEST_DIR/shows")
ask() {
  [ $y = 1 ] && { echo "$host $1 $2" >> "$known"; return; }
  answer=$(dd bs=1 count=1 2>/dev/null)
  [ "$answer" = y ] || { echo "Didn't validate host key" >&2; exit 1; }
}
if grep -qx "$host $1 $2" "$known" 2>/dev/null; then :
elif grep -q "^$host $1 " "$known" 2>/dev/null; then echo "Host key mismatch for $host !" >&2; exit 1
else ask "$1" "$2"
fi
exec sh -c "$command"
`;

// macOS has no setsid: perl's stands in, in place, as busybox's does.
const fakeSetsid = `#!/bin/sh
exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' "$@"
`;

qjsTest("dbclient is given exactly the known_hosts meant, never root's own; local commands are killed whole", (t) => {
  const root = join(__dirname, "../../..");
  const work = tempDir("qjsssh");
  const bin = join(work, "bin");
  const home = join(work, "home");
  const dir = join(work, "test");
  mkdirSync(bin);
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(dir);
  writeFileSync(join(home, ".ssh/known_hosts"), "10.9.9.9 ssh-ed25519 AAAAroot\n");
  writeFileSync(join(bin, "dbclient"), fakeDbclient);
  chmodSync(join(bin, "dbclient"), 0o755);
  if (!hasSetsid) {
    writeFileSync(join(bin, "setsid"), fakeSetsid);
    chmodSync(join(bin, "setsid"), 0o755);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { bundleForQjs } = require("../../../scripts/bundle.js");
  const entry = join(work, "entry.mjs");
  bundleForQjs(join(root, "src/tests/helpers/qjsSshEntry.ts"), entry);
  const result = spawnSync("qjs", ["--module", entry], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, ONC_TEST_DIR: dir },
  });
  t.is(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  t.deepEqual(lines.filter((line) => !line.startsWith("PASS")), []);
  t.is(lines.length, 14, result.stdout);
  t.is(readFileSync(join(home, ".ssh/known_hosts"), "utf8"), "10.9.9.9 ssh-ed25519 AAAAroot\n");
});
