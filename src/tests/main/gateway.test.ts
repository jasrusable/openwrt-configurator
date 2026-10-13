// This machine's own MACs, as `ifconfig` (macOS) and `ip -o link` (Linux) print them.
import test from "ava";
import { ownMacs } from "../../apply/gateway";

const answering = (os: string, stdout: string) => ({ os, run: async () => ({ stdout, stderr: "", code: 0 }) }) as never;

test("this machine's MACs: ether lines only, lower case, no loopback or broadcast", async (t) => {
  t.deepEqual(
    await ownMacs(answering("darwin", "lo0: flags=8049<UP>\n\tinet 127.0.0.1\nen0: flags=8863<UP>\n\tether 3C:22:FB:00:11:22\n\tinet 10.0.0.5\nbridge0:\n\tether 36:1a:02:00:00:00\n")),
    ["3c:22:fb:00:11:22", "36:1a:02:00:00:00"]
  );
  t.deepEqual(
    await ownMacs(answering("linux", "1: lo: <LOOPBACK> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n2: wlan0: <BROADCAST> mtu 1500\\    link/ether 3c:22:fb:00:11:23 brd ff:ff:ff:ff:ff:ff\n")),
    ["3c:22:fb:00:11:23"]
  );
  t.deepEqual(await ownMacs({ os: "linux", run: async () => { throw new Error("no ip"); } } as never), []);
});
