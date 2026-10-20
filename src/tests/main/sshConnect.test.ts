import test from "ava";
import { agentSocketFor, following, provisionableDevices, sshConnectOptions } from "../../apply/provisionConfig";
import { PlanDevice } from "../../plan/types";
import { planOf } from "../helpers/fixtures";
import { deviceFromJson } from "../../lowLevel/names";
import { homedir } from "os";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";

/** A device as a low-level config writes it (`provisioning_config.ssh_auth`), read as the plan has it. */
const device = (provisioning_config: { ssh_auth: { username: string; password?: string; private_key_path?: string } }): PlanDevice =>
  deviceFromJson({ model_id: "test", ipaddr: "10.0.0.1", hostname: "box", tags: {}, provisioning_config });

test("password-only auth", (t) => {
  const opts = sshConnectOptions({
    platform: nodePlatform,
    deviceConfig: device({
      ssh_auth: { username: "root", password: "secret" },
    }),
    agentSocket: "/tmp/agent.sock",
  });
  t.is(opts.username, "root");
  t.is(opts.host, "10.0.0.1");
  t.is(opts.password, "secret");
  t.is(opts.privateKeyPath, undefined);
  t.is(opts.agent, "/tmp/agent.sock");
});

test("a public key path names the agent's key, beside the password", (t) => {
  const opts = sshConnectOptions({
    platform: nodePlatform,
    deviceConfig: device({
      ssh_auth: { username: "root", password: "secret", private_key_path: "~/.ssh/id_1password.pub" },
    }),
    agentSocket: "/tmp/agent.sock",
  });
  t.is(opts.privateKeyPath, undefined);
  t.is(opts.agent, "/tmp/agent.sock");
  t.is(opts.password, "secret");
});

test("private_key_path without password", (t) => {
  const opts = sshConnectOptions({
    platform: nodePlatform,
    deviceConfig: device({
      ssh_auth: {
        username: "root",
        private_key_path: "/tmp/id_ed25519",
      },
    }),
    agentSocket: "/tmp/agent.sock",
  });
  t.is(opts.privateKeyPath, "/tmp/id_ed25519");
  t.is(opts.password, undefined);
  t.is(opts.agent, undefined);
});

test("CLI identity overrides JSON private_key_path", (t) => {
  const opts = sshConnectOptions({
    platform: nodePlatform,
    deviceConfig: device({
      ssh_auth: {
        username: "root",
        private_key_path: "/tmp/from-json",
        password: "also-here",
      },
    }),
    identityPath: "/tmp/from-cli",
  });
  t.is(opts.privateKeyPath, "/tmp/from-cli");
  t.is(opts.password, "also-here");
});

test("expands ~ in the key path", (t) => {
  const opts = sshConnectOptions({
    platform: nodePlatform,
    deviceConfig: device({
      ssh_auth: { username: "root", private_key_path: "~/.ssh/id_ed25519" },
    }),
  });
  t.is(opts.privateKeyPath, join(homedir(), ".ssh/id_ed25519"));
});

test("agent is used when there is no password and no key", (t) => {
  const opts = sshConnectOptions({
    platform: nodePlatform,
    deviceConfig: device({ ssh_auth: { username: "root" } }),
    agentSocket: "/tmp/agent.sock",
  });
  t.is(opts.agent, "/tmp/agent.sock");
  t.is(opts.privateKeyPath, undefined);
  t.is(opts.password, undefined);
});

test("no agent when SSH_AUTH_SOCK is unset and there is no secret", (t) => {
  const opts = sshConnectOptions({
    platform: nodePlatform,
    deviceConfig: device({ ssh_auth: { username: "root" } }),
  });
  t.is(opts.agent, undefined);
});

test("only devices with an address and SSH login are provisioned", (t) => {
  const auth = { ssh_auth: { username: "root", password: "x" } };
  const base = { model_id: "m", tags: {} };
  const { ready, skipped } = provisionableDevices({
    devices: ([
      {
        ...base,
        hostname: "router",
        ipaddr: "10.0.0.1",
        provisioning_config: auth,
      },
      { ...base, hostname: "image-only" },
      { ...base, hostname: "no-login", ipaddr: "10.0.0.2" },
      {
        ...base,
        hostname: "off",
        ipaddr: "10.0.0.3",
        provisioning_config: auth,
        enabled: false,
      },
    ] as Parameters<typeof deviceFromJson>[0][]).map(deviceFromJson),
    config: {},
  } as any);
  t.deepEqual(
    ready.map((d) => d.hostname),
    ["router"]
  );
  // Disabled devices are left out quietly; the others say why.
  t.deepEqual(skipped, [
    { hostname: "image-only", reason: "no ipaddr" },
    { hostname: "no-login", reason: "no provisioning_config.ssh_auth" },
  ]);
});

test("a device needs no ipaddr to be valid", (t) => {
  t.notThrows(() =>
    planOf({
      devices: [{ model_id: "m", hostname: "image-only", tags: {} }],
      config: {},
    })
  );
});

test("the agent is OpenSSH's IdentityAgent for the host, else SSH_AUTH_SOCK", async (t) => {
  const platform = (stdout: string, code = 0) => ({
    run: async () => ({ code, stdout, stderr: "" }),
    env: (name: string) => (name === "SSH_AUTH_SOCK" ? "/tmp/env.sock" : undefined),
    homedir: () => "/home/me",
  });
  t.is(await agentSocketFor("a.lan", platform('user root\nidentityagent "~/Library/1p/agent.sock"\n')), "/home/me/Library/1p/agent.sock");
  t.is(await agentSocketFor("b.lan", platform("identityagent SSH_AUTH_SOCK\n")), "/tmp/env.sock");
  t.is(await agentSocketFor("c.lan", platform("identityagent none\n")), undefined);
  t.is(await agentSocketFor("d.lan", platform("", 255)), "/tmp/env.sock");
});

test("an apply's connections follow a device that moved, only held to its key", async (t) => {
  const key = { type: "ssh-ed25519", key: "AAAA" };
  const answering = new Set(["192.0.2.67"]);
  const tried: string[] = [];
  const connectAt = async (d: PlanDevice, hostKey?: { type: string; key: string }) => {
    tried.push(`${d.ipaddr}${hostKey ? " pinned" : ""}`);
    if (!answering.has(d.ipaddr!)) throw new Error(`${d.ipaddr} is not answering`);
    return { address: d.ipaddr } as never;
  };
  const ap = { ...device({ ssh_auth: { username: "root" } }), hostname: "ap", ipaddr: "192.0.2.67" };
  const connect = following({ hostKeys: { ap: key }, alsoAt: { ap: ["ap.lan"] }, connectAt, log: () => {} });
  await connect(ap);
  t.deepEqual(tried, ["192.0.2.67 pinned"]);
  // Its lease renewed at commit: the configured name now leads to it.
  answering.clear();
  answering.add("ap.lan");
  tried.length = 0;
  await connect(ap);
  t.deepEqual(tried, ["192.0.2.67 pinned", "ap.lan pinned"]);
  // And it is looked for there first from then on.
  tried.length = 0;
  await connect(ap);
  t.deepEqual(tried, ["ap.lan pinned"]);
  // Nowhere answering: each address's failure is said.
  answering.clear();
  await t.throwsAsync(connect(ap), { message: "ap.lan: ap.lan is not answering; 192.0.2.67: 192.0.2.67 is not answering" });
  // Without a key on record, nowhere but where it was found.
  const unpinned = following({ hostKeys: {}, alsoAt: { ap: ["ap.lan"] }, connectAt, log: () => {} });
  tried.length = 0;
  await t.throwsAsync(unpinned(ap), { message: /192\.0\.2\.67 is not answering/ });
  t.deepEqual(tried, ["192.0.2.67"]);
});
