import test from "ava";
import { spawn, spawnSync } from "child_process";
import { createServer, Server } from "net";
import {
  reachableSession,
  sshAnswersCommand,
} from "../../provisionOpenWrtDevice";
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
  t.true(sshAnswersCommand("a'b").includes(`nc 'a'\\''b' 22`));
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
    const child = spawn("sh", ["-c", sshAnswersCommand("127.0.0.1", port)]);
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
