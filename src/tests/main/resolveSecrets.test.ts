import test from "ava";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadOncConfig } from "../../loadConfig";
import {
  assertSecretName,
  findPlaintextSecrets,
  KEYCHAIN_SERVICE,
  parseSecurityPassword,
  redactValue,
  resolveSecrets,
  SecretLookup,
  stripOneTrailingNewline,
} from "../../resolveSecrets";
import { getUciCommands } from "../../getUciCommands";
import { getUciDefaultsScript } from "../../getBuildPlan";

const lookupFrom = (store: Record<string, string>): SecretLookup => {
  const counts = new Map<string, number>();
  const lookup: SecretLookup & { counts: Map<string, number> } = async (
    name
  ) => {
    counts.set(name, (counts.get(name) || 0) + 1);
    return store[name];
  };
  lookup.counts = counts;
  return lookup;
};

test("replaces $secret refs via lookup", async (t) => {
  const lookup = lookupFrom({
    "wifi/home": "testpsk1",
    pppoe: "pppoe-pass",
  });
  const { value, secrets } = await resolveSecrets(
    {
      key: { $secret: "wifi/home" },
      nested: { password: { $secret: "pppoe" } },
    },
    lookup
  );
  t.deepEqual(value, { key: "testpsk1", nested: { password: "pppoe-pass" } });
  t.is(secrets.get("wifi/home"), "testpsk1");
  t.is(secrets.get("pppoe"), "pppoe-pass");
});

test("looks up each name once", async (t) => {
  const lookup = lookupFrom({ "wifi/home": "testpsk1" }) as SecretLookup & {
    counts: Map<string, number>;
  };
  await resolveSecrets(
    {
      a: { $secret: "wifi/home" },
      b: [{ $secret: "wifi/home" }],
    },
    lookup
  );
  t.is(lookup.counts.get("wifi/home"), 1);
});

test("walks .overrides", async (t) => {
  const { value } = await resolveSecrets(
    {
      key: "plaintext",
      ".overrides": [
        {
          ".if": "device.hostname == 'ap-2'",
          override: { key: { $secret: "wifi/guest" } },
        },
      ],
    },
    lookupFrom({ "wifi/guest": "guestpsk1" })
  );
  t.deepEqual(value, {
    key: "plaintext",
    ".overrides": [
      {
        ".if": "device.hostname == 'ap-2'",
        override: { key: "guestpsk1" },
      },
    ],
  });
});

test("collects every missing name before failing", async (t) => {
  const error = await t.throwsAsync(
    resolveSecrets(
      {
        key: { $secret: "wifi/home" },
        password: { $secret: "pppoe" },
      },
      lookupFrom({})
    )
  );
  t.true(error?.message.includes(`service ${KEYCHAIN_SERVICE}`));
  t.true(error?.message.includes("  - pppoe"));
  t.true(error?.message.includes("  - wifi/home"));
  t.true(error?.message.includes("secrets set <name>"));
});

test("rejects malformed $secret objects", async (t) => {
  const error = await t.throwsAsync(
    resolveSecrets(
      {
        a: { $secret: "wifi/home", extra: 1 },
        b: { $secret: 1 },
        c: { $secret: "wifi home" },
      },
      lookupFrom({})
    )
  );
  t.true(error?.message.startsWith("Invalid $secret references:"));
  t.true(error?.message.includes('a: $secret object must contain only { "$secret": "name" }'));
  t.true(error?.message.includes("b: $secret must be a string"));
  t.true(error?.message.includes("c:"));
});

test("leaves plaintext strings alone and does not look them up", async (t) => {
  const lookup = lookupFrom({}) as SecretLookup & { counts: Map<string, number> };
  const input = { key: "test123456", list: ["a", 1, true, null] };
  const { value, secrets } = await resolveSecrets(input, lookup);
  t.deepEqual(value, input);
  t.is(secrets.size, 0);
  t.is(lookup.counts.size, 0);
});

test("redacts a whole value and leaves text that merely contains it", (t) => {
  const secrets = new Map([["lan", "192.168.1"]]);
  t.is(redactValue("192.168.1", secrets), "{ $secret: lan }");
  t.is(redactValue("192.168.1.1", secrets), "192.168.1.1");
});

test("shared secret values use one token", (t) => {
  const secrets = new Map([
    ["b", "same-value"],
    ["a", "same-value"],
  ]);
  t.is(redactValue("same-value", secrets), "{ $secret: a, b }");
});

test("redact skips empty values", (t) => {
  const secrets = new Map([["empty", ""]]);
  t.is(redactValue("keep", secrets), "keep");
  t.is(redactValue("", secrets), "");
});

test("uci values are redacted before they are quoted", (t) => {
  const commands = getUciCommands({
    openWrtConfig: {
      network: {
        interface: [
          {
            ".name": "lan",
            ipaddr: "192.168.1.1",
            proto: "o'brien",
          },
        ],
      },
    } as any,
    redact: (value) => redactValue(value, new Map([["wan", "o'brien"]])),
  });
  const script = commands.join("\n");
  t.false(script.includes("o'brien"));
  t.true(script.includes("{ $secret: wan }"));
  t.true(script.includes("192.168.1.1"));
});

test("uci defaults redact before shell quoting", (t) => {
  const script = getUciDefaultsScript({
    lan: { ipaddr: "it'o", proto: "static" },
    redact: (value) => redactValue(value, new Map([["gw", "it'o"]])),
  });
  t.false(script.includes("it'o"));
  t.true(script.includes("{ $secret: gw }"));
  t.true(script.includes("static"));
});

test("parseSecurityPassword keeps a quoted hex-looking value", (t) => {
  t.is(parseSecurityPassword('password: "deadbeef"\n'), "deadbeef");
  t.is(
    parseSecurityPassword('password: "say \\"hi\\" \\\\ now"\n'),
    'say "hi" \\ now'
  );
});

test("parseSecurityPassword decodes a 0x dump and ignores the lossy quote", (t) => {
  t.is(parseSecurityPassword("password: 0x616263C2A3\n"), "abc£");
  t.is(
    parseSecurityPassword('password: 0x616263C2A3  "abc\\243"\n'),
    "abc£"
  );
  t.is(
    parseSecurityPassword("password: 0x6C696E65310A6C696E6532\n"),
    "line1\nline2"
  );
});

test("parseSecurityPassword rejects a bare hex line", (t) => {
  t.is(parseSecurityPassword("keychain: login\n"), undefined);
  t.throws(() => parseSecurityPassword("password: deadbeef\n"));
  t.throws(() => parseSecurityPassword("password: 0xabc\n"));
});

test("findPlaintextSecrets reports password and key strings", (t) => {
  t.deepEqual(
    findPlaintextSecrets({
      devices: [
        {
          provisioning_config: {
            ssh_auth: { username: "root", password: "x" },
          },
        },
      ],
      config: {
        wireless: {
          "wifi-iface": [{ ssid: "home", key: "test123456" }],
        },
        network: {
          interface: [{ ".name": "wan", password: { $secret: "pppoe" } }],
        },
      },
    }),
    [
      "devices[0].provisioning_config.ssh_auth.password",
      "config.wireless.wifi-iface[0].key",
    ]
  );
});

test("stripOneTrailingNewline strips one newline only", (t) => {
  t.is(stripOneTrailingNewline("psk\n"), "psk");
  t.is(stripOneTrailingNewline("psk\r\n"), "psk");
  t.is(stripOneTrailingNewline("psk\n\n"), "psk\n");
  t.is(stripOneTrailingNewline("ps k"), "ps k");
});

test("assertSecretName rejects spaces and empty", (t) => {
  t.throws(() => assertSecretName(""));
  t.throws(() => assertSecretName("wifi home"));
  t.throws(() => assertSecretName("wifi;rm"));
  t.notThrows(() => assertSecretName("wifi/home"));
  t.notThrows(() => assertSecretName("ssh.root@ap-1"));
});

test("loadOncConfig resolves refs then validates the schema", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "onc-secrets-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      devices: [
        {
          model_id: "ubnt,edgerouter-x",
          ipaddr: "10.0.0.1",
          hostname: "r1",
          tags: { role: "router" },
          provisioning_config: {
            ssh_auth: {
              username: "root",
              password: { $secret: "ssh/root" },
            },
          },
        },
      ],
      config: {
        wireless: {
          "wifi-iface": [
            {
              mode: "ap",
              device: "radio0",
              ssid: "test",
              encryption: "psk2",
              key: { $secret: "wifi/home" },
            },
          ],
        },
        network: {
          interface: [
            {
              ".name": "wan",
              proto: "pppoe",
              username: "me",
              password: { $secret: "pppoe" },
            },
          ],
        },
      },
    })
  );
  try {
    const { oncConfig, secrets } = await loadOncConfig(path, {
      lookup: lookupFrom({
        "ssh/root": "ssh-pass-ok",
        "wifi/home": "testpsk1",
        pppoe: "pppoe-pass",
      }),
    });
    t.is(oncConfig.devices[0].provisioning_config?.ssh_auth.password, "ssh-pass-ok");
    t.is((oncConfig.config as any).wireless["wifi-iface"][0].key, "testpsk1");
    t.is((oncConfig.config as any).network.interface[0].password, "pppoe-pass");
    t.is(secrets.get("wifi/home"), "testpsk1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
