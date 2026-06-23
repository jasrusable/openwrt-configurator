import { NodeSSH } from "node-ssh";

export const parseSections = (configString: string) => {
  const sections: Record<string, string[]> = {};

  let config: string | undefined = undefined;

  configString.split("\n").forEach((rawLine) => {
    const [keyword, value] = rawLine.replace(/^\t/, "").split(" ");
    if (keyword === "package") {
      config = value?.replace(/'/g, "");
    } else if (keyword === "config" && config && value) {
      // Dedupe section types per-package, not globally. A global dedupe
      // attributes a type shared across packages (e.g. `defaults` in both
      // firewall and qosify, or `interface`/`device` in both network and
      // qosify) to whichever package it appears in first, silently dropping
      // it from later ones — so qosify.@defaults[0] never gets reset and the
      // package-shipped anonymous section duplicates on every provision.
      const sectionType = value.replace(/'/g, "");
      const seen = sections[config] || [];
      if (!seen.includes(sectionType)) {
        sections[config] = [...seen, sectionType];
      }
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
