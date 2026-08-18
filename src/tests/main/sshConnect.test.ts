import test from "ava";
import { sshConnectOptions } from "../../provisionConfig";
import { ONCDeviceConfig } from "../../oncConfigSchema";
import { homedir } from "os";
import { join } from "path";

const device = (
  ssh_auth: ONCDeviceConfig["provisioning_config"]
): ONCDeviceConfig =>
  ({
    model_id: "test",
    ipaddr: "10.0.0.1",
    hostname: "box",
    tags: {},
    provisioning_config: ssh_auth,
  } as ONCDeviceConfig);

test("password-only auth", (t) => {
  const opts = sshConnectOptions({
    deviceConfig: device({
      ssh_auth: { username: "root", password: "secret" },
    }),
    agentSocket: "/tmp/agent.sock",
  });
  t.is(opts.username, "root");
  t.is(opts.host, "10.0.0.1");
  t.is(opts.password, "secret");
  t.is(opts.privateKeyPath, undefined);
  t.is(opts.agent, undefined);
});

test("private_key_path without password", (t) => {
  const opts = sshConnectOptions({
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
    deviceConfig: device({
      ssh_auth: { username: "root", private_key_path: "~/.ssh/id_ed25519" },
    }),
  });
  t.is(opts.privateKeyPath, join(homedir(), ".ssh/id_ed25519"));
});

test("agent is used when there is no password and no key", (t) => {
  const opts = sshConnectOptions({
    deviceConfig: device({ ssh_auth: { username: "root" } }),
    agentSocket: "/tmp/agent.sock",
  });
  t.is(opts.agent, "/tmp/agent.sock");
  t.is(opts.privateKeyPath, undefined);
  t.is(opts.password, undefined);
});

test("no agent when SSH_AUTH_SOCK is unset and there is no secret", (t) => {
  const opts = sshConnectOptions({
    deviceConfig: device({ ssh_auth: { username: "root" } }),
  });
  t.is(opts.agent, undefined);
});
