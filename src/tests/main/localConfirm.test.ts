import test from "ava";
import { tempDir } from "../helpers/tempDir";
import { spawn, spawnSync } from "child_process";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createServer, Server } from "net";
import { reachableSession, reconnectSettled } from "../../apply/reconnect";
import { answersSsh, servicesSettled } from "../../deviceProbes";
import { Session } from "../../platform";

const fakeSession = (local: boolean, checkOutput: string) => {
  const commands: string[] = [];
  let disposed = false;
  const session: Session = {
    local,
    execCommand: async (command) => {
      commands.push(command);
      return { stdout: checkOutput, stderr: "", code: 0 };
    },
    dispose: () => {
      disposed = true;
    },
  };
  return { session, commands, disposed: () => disposed };
};

test("a remote session is confirmed by reconnecting alone", async (t) => {
  const fake = fakeSession(false, "");
  const session = await reachableSession({
    connect: async () => fake.session,
    host: "10.0.0.1",
  })();
  t.is(session, fake.session);
  t.deepEqual(fake.commands, []);
});

test("a local session needs its address to answer SSH", async (t) => {
  const up = fakeSession(true, "ONC_SSH_OK\n");
  t.is(
    await reachableSession({
      connect: async () => up.session,
      host: "10.0.0.1",
    })(),
    up.session
  );
  t.true(up.commands[0].includes("nc '10.0.0.1' 22"));

  const down = fakeSession(true, "ONC_SSH_DOWN\n");
  await t.throwsAsync(
    reachableSession({ connect: async () => down.session, host: "10.0.0.1" })(),
    { message: /not answering SSH/ }
  );
  t.true(down.disposed());
});

test("the host is shell-quoted", (t) => {
  t.true(answersSsh("a'b").command.includes(`nc 'a'\\''b' 22`));
});

// The real snippet against real sockets. Busybox nc on OpenWrt is not the nc
// here, so this checks the shell logic; the device check covers the applet.
const listen = (onConnection: (socket: any) => void) =>
  new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createServer(onConnection).listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as any).port })
    );
  });

const runSnippet = (port: number) =>
  new Promise<string>((resolve) => {
    const child = spawn("sh", ["-c", answersSsh("127.0.0.1", port).command]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out.trim()));
  });

const hasNc = spawnSync("sh", ["-c", "command -v nc"]).status === 0;

(hasNc ? test : test.skip)(
  "the snippet sees a banner, a closed port and a mute server",
  async (t) => {
    const banner = await listen((socket) => socket.write("SSH-2.0-fake\r\n"));
    const mute = await listen(() => {});
    const closed = await listen(() => {});
    const closedPort = closed.port;
    closed.server.close();
    try {
      t.is(await runSnippet(banner.port), "ONC_SSH_OK");
      t.is(await runSnippet(mute.port), "ONC_SSH_DOWN");
      t.is(await runSnippet(closedPort), "ONC_SSH_DOWN");
    } finally {
      banner.server.close();
      mute.server.close();
    }
  }
);

// A fake `ubus` whose service list changes on each of the first `changes`
// calls and is stable after that, standing in for procd reloading services,
// and a `sleep` that returns at once: the loop is counted in calls, not timed.
const withFakeUbus = (changes: number) => {
  const dir = tempDir("ubus");
  writeFileSync(
    join(dir, "ubus"),
    `#!/bin/sh\nn=$(cat ${dir}/n 2>/dev/null || echo 0); echo $((n+1)) > ${dir}/n\n` +
      `[ $n -lt ${changes} ] && echo "changing $n" || echo stable\n`
  );
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\n");
  chmodSync(join(dir, "ubus"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
  return dir;
};

/** How the settle loop ended, and how many times it asked procd. */
const runSettle = (dir: string, maxSeconds: number) =>
  new Promise<{ status: number | null; calls: number }>((resolve) => {
    spawn("sh", ["-c", servicesSettled(maxSeconds).command], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdio: "ignore",
    }).on("close", (status) =>
      resolve({ status, calls: Number(readFileSync(join(dir, "n"), "utf8")) })
    );
  });

test("settling waits for three unchanged reads after the last change", async (t) => {
  // Changes on calls 1–3, the 4th differs from the 3rd, then three equal: 7.
  t.deepEqual(await runSettle(withFakeUbus(3), 20), { status: 0, calls: 7 });
});

test("settling gives up at its cap if services keep changing", async (t) => {
  t.deepEqual(await runSettle(withFakeUbus(1000), 4), { status: 0, calls: 4 });
});

test("reconnectSettled settles on one session and confirms on a fresh one", async (t) => {
  const events: string[] = [];
  const session = (name: string): Session => ({
    execCommand: async (command) => {
      events.push(
        `${name}: ${
          command.includes("ubus call service list") ? "settle" : command
        }`
      );
      return { stdout: "", stderr: "", code: 0 };
    },
    dispose: () => events.push(`${name}: dispose`),
  });
  const confirmed = await reconnectSettled({
    connect: async () => session("first"),
    confirmWith: async () => session("second"),
    deadline: Date.now() + 60000,
    sleep: async () => {},
  });
  await confirmed.execCommand("touch confirm");
  t.deepEqual(events, [
    "first: settle",
    "first: dispose",
    "second: touch confirm",
  ]);
});
