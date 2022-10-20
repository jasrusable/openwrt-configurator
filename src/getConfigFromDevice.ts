import { NodeSSH } from "node-ssh";

const parseConfigString = (configString: string) => {
  const configLines = configString.split("\n");
  const parsedLines = [
    ...new Set(
      configLines
        .map((line) => line.replace("\t", ""))
        .filter((line) => line.length > 0)
        .filter(
          (line) => line.startsWith("package") || line.startsWith("config")
        )
        .map((line) => line.split(" ").slice(0, 2).join(" "))
    ),
  ];

  const sections: any = {};

  let config: any = undefined;

  parsedLines.forEach((line) => {
    const [type, name] = line.split(" ");
    if (type === "package") {
      config = name;
    } else {
      sections[config] = [...(sections[config] || []), name];
    }
  });

  console.log({ sections });
};

export const getConfigFromDevice = async ({
  ipAddress,
  auth,
}: {
  ipAddress: string;
  auth: {
    username: string;
    password: string;
  };
}) => {
  const ssh = new NodeSSH();

  const connectedSsh = await ssh.connect({
    host: ipAddress,
    username: auth.username,
    password: auth.password,
  });

  const command = await connectedSsh.execCommand(`uci export`);
  if (!command.stdout || command.code !== 0) {
    if (command.stderr === "Command failed: Not found") {
      return [];
    } else {
      console.error(command.stderr);
      throw new Error("Failed to get config");
    }
  }

  const configString = command.stdout;

  const config = parseConfigString(configString);

  return config;
};

(async () => {
  await getConfigFromDevice({
    ipAddress: "10.0.0.155",
    auth: { username: "root", password: "Jason101!!@@" },
  });

  process.exit();
})();
