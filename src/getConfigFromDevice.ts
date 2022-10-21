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

export const getSectionsToReset = async (ssh: NodeSSH) => {
  const command = await ssh.execCommand(`uci export`);
  if (!command.stdout || command.code !== 0) {
    if (command.stderr === "Command failed: Not found") {
      return [];
    } else {
      console.error(command.stderr);
      throw new Error("Failed to get config");
    }
  }

  const configString = command.stdout;

  const sectionsObject = parseSections(configString);

  const configSections = Object.keys(sectionsObject).reduce<string[][]>(
    (acc, configKey) => {
      const sections = sectionsObject[configKey].map((sectionKey) => [
        configKey,
        sectionKey,
      ]);
      return [...acc, ...sections];
    },
    []
  );

  return configSections;
};

(async () => {
  const ssh = new NodeSSH();

  const connectedSsh = await ssh.connect({
    host: "10.0.0.155",
    username: "root",
    password: "test",
  });

  await getSectionsToReset(connectedSsh);

  process.exit();
})();
