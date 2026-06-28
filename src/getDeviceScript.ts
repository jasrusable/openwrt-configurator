import { posix as posixPath } from "path";
import { NodeSSH } from "node-ssh";
import { dhcpSectionsToReset } from "./configSchemas/dhcp";
import { firewallSectionsToReset } from "./configSchemas/firewall";
import { networkSectionsToReset } from "./configSchemas/network";
import { systemSectionsToReset } from "./configSchemas/system";
import { wirelessSectionsToReset } from "./configSchemas/wireless";
import { getUciCommands } from "./getUciCommands";
import { OpenWrtState } from "./openWrtConfigSchema";
import { getInstalledPackages, getManagedFiles } from "./utils";

// Manifest of files written by this tool, so files removed from config are
// removed from the device on the next provision (declarative, like UCI resets).
const managedFilesManifest = "/etc/onc/managed_files";

// Pick a heredoc delimiter guaranteed not to occur in the content.
const heredocDelimiter = (content: string) => {
  let delimiter = "ONC_EOF";
  while (content.includes(delimiter)) {
    delimiter = `${delimiter}_`;
  }
  return delimiter;
};

const writeFileCommand = (path: string, content: string, mode?: string) => {
  // Write via a quoted heredoc: `cat` is always present (unlike the `base64`
  // applet, which is missing on stripped/small-flash busybox builds), and a
  // quoted delimiter keeps content literal so `$vars` in scripts aren't
  // expanded at write time.
  const delimiter = heredocDelimiter(content);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return [
    `mkdir -p '${posixPath.dirname(path)}'`,
    `cat > '${path}' <<'${delimiter}'`,
    `${body}${delimiter}`,
    ...(mode ? [`chmod ${mode} '${path}'`] : []),
  ].join("\n");
};

const sectionsToReset: any = {
  ...dhcpSectionsToReset,
  ...firewallSectionsToReset,
  ...networkSectionsToReset,
  ...systemSectionsToReset,
  ...wirelessSectionsToReset,
};

const configSectionMapping = Object.keys(sectionsToReset).reduce<any[]>(
  (acc, configKey) => {
    const r = Object.keys(sectionsToReset[configKey]).map((sectionKey) => {
      return [configKey, sectionKey];
    });
    return [...acc, ...r];
  },
  []
);

export const builtInResetCommands = configSectionMapping.map(
  ([configKey, sectionKey]) => {
    return `while uci -q delete ${configKey}.@${sectionKey}[0]; do :; done`;
  }
);

export const builtInRevertCommands = Object.keys(sectionsToReset).map(
  (configKey) => {
    return `uci revert ${configKey}`;
  }
);

export const getDeviceScript = async ({
  state,
  ssh,
}: {
  state: OpenWrtState;
  ssh?: NodeSSH;
}) => {
  const uciCommands = getUciCommands({ openWrtConfig: state.config });

  const configSections =
    state.configSectionsToReset &&
    Object.keys(state.configSectionsToReset).reduce<string[][]>(
      (acc, configKey) => {
        const sections = (state.configSectionsToReset?.[configKey] || []).map(
          (sectionKey) => [configKey, sectionKey]
        );
        return [...acc, ...sections];
      },
      []
    );

  const resetCommands = configSections
    ? configSections.map(([configKey, sectionKey]) => {
        return `while uci -q delete ${configKey}.@${sectionKey}[0]; do :; done`;
      })
    : [];

  const installedPackages = ssh ? await getInstalledPackages(ssh) : undefined;

  const packagesToUninstall = installedPackages
    ? (state.packagesToUninstall || []).filter((p) =>
        installedPackages.find((pk) => pk.packageName === p)
      )
    : state.packagesToUninstall;

  const packagesToInstall = installedPackages
    ? (state.packagesToInstall || []).filter(
        (p) => !installedPackages.find((pk) => pk.packageName === p.packageName)
      )
    : state.packagesToInstall;

  const packageCommands = [
    ...(packagesToUninstall && packagesToUninstall.length > 0
      ? [
          `apk del --rdepends ${packagesToUninstall.join(" ")}`,
        ]
      : []),
    ...(packagesToInstall && packagesToInstall.length > 0
      ? [
          `apk add --update-cache ${packagesToInstall
            .map((p) => p.packageName)
            .join(" ")}`,
        ]
      : []),
  ];

  const files = state.files || [];
  const previouslyManagedFiles = ssh
    ? await getManagedFiles(ssh, managedFilesManifest)
    : undefined;
  const staleFiles = (previouslyManagedFiles || []).filter(
    (path) => !files.find((file) => file.path === path)
  );

  const fileCommands =
    files.length > 0 || staleFiles.length > 0
      ? [
          ...staleFiles.map((path) => `rm -f '${path}'`),
          ...files.flatMap((file) => [
            writeFileCommand(file.path, file.content, file.mode),
            // Optional command run immediately after the file is written (e.g.
            // trigger a freshly-written hotplug script so it applies now).
            ...(file.run_after ? [file.run_after] : []),
          ]),
          writeFileCommand(
            managedFilesManifest,
            files.map((file) => file.path).join("\n")
          ),
        ]
      : [];

  // Files are written before `uci commit` so a file-write failure aborts before
  // the UCI changes are committed (the revert is then effective), and so a
  // freshly-written hotplug script is in place when reload_config runs.
  return [
    ...packageCommands,
    ...resetCommands,
    ...uciCommands,
    ...fileCommands,
    "uci commit",
    "reload_config",
  ];
};
