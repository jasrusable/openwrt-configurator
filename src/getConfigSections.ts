import { NodeSSH } from "node-ssh";

const parseSections = (configString: string) => {
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

  const sections: Record<string, string[]> = {};

  let config: any = undefined;

  parsedLines.forEach((line) => {
    const [type, name] = line.split(" ");
    if (type === "package") {
      config = name;
    } else {
      sections[config] = [...(sections[config] || []), name];
    }
  });

  return sections;
};

export const getConfigSections = async (ssh: NodeSSH) => {
  const command = await ssh.execCommand(`uci export`);
  if (!command.stdout || command.code !== 0) {
    console.error(command.stderr);
    throw new Error("Failed to export uci config");
  }
  const configString = command.stdout;
  const configSections = parseSections(configString);
  return configSections;
};
